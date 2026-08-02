#!/usr/bin/env bun

/**
 * Proves what Phase 6 exits on, without a Telegram token and without one call to
 * Telegram.
 *
 * The bot's own handlers are registered exactly as `apps/bot/src/index.ts`
 * registers them, on a real grammy `Bot`, and driven with synthetic updates
 * through `bot.handleUpdate` — the same entry point long polling uses. What is
 * substituted is the two things that would leave the machine: every Telegram API
 * call is answered by a transformer installed on `bot.api`, so `getMe`, a reply
 * and a callback answer are recorded rather than sent; and the manager turn is a
 * layer that answers without a container, because a real turn is a docker
 * daemon, a subscription credential and a model call.
 *
 * Everything else is the real thing. A real Postgres, the real allow-list parse,
 * the real access gate, the real router, the real thread repository, and the
 * real `atm.chat` ledger read back off the disk.
 *
 * Five claims:
 *
 * **The door.** An account nobody allow-listed is refused with one sentence and
 * leaves one row saying `not_allowed` with no user on it. A refusal that vanishes
 * is the one failure nobody could count.
 *
 * **The conversation.** A text message from an allow-listed account opens a
 * thread, stores the message, and leaves a row naming the thread.
 *
 * **The switch.** `/new` opens a second conversation and takes over as current;
 * a *Switch* button on the first makes it current again — the callback decoded
 * through its schema, not cast out of the update.
 *
 * **The notice.** A finished run renders into a message a person can read, with
 * the buttons its task's status earns.
 *
 * **The stuck rule.** A window of repeated tool calls with no file edit is
 * `stuck`; the same window one edit later is not.
 *
 * Everything is scoped to its own data root (`${DATA_ROOT}/bot-check`) so a real
 * bot's ledger is never appended to, and to a fresh Telegram chat id per run so
 * two invocations cannot read each other's conversation. The chat rows it files
 * stay: there is no delete on a conversation, by design.
 *
 * Usage: `bun run bot:check`.
 */

import { join } from "node:path";
import process from "node:process";

/**
 * Every setting the bot reads that this check owns, pinned before a layer is
 * built.
 *
 * Written onto the process environment because that is what `Config` reads, and
 * because the ledger this check reads back has to be the one the layer writes —
 * a second spelling of that path is a check that reads an empty file and passes.
 */
const CHECK_SEGMENT = "bot-check";
const CONFIGURED_ROOT = process.env.DATA_ROOT?.trim() || ".data";
const CHECK_ROOT = CONFIGURED_ROOT.endsWith(CHECK_SEGMENT)
  ? CONFIGURED_ROOT
  : join(CONFIGURED_ROOT, CHECK_SEGMENT);
const CHECK_EVENT_DIR = join(CHECK_ROOT, "events");
process.env.DATA_ROOT = CHECK_ROOT;
process.env.EVENT_LOG_DIR = CHECK_EVENT_DIR;
// Nothing here starts a container; the manager is a layer that answers without
// one. Pinned anyway so the sandbox layer cannot go looking for a daemon.
process.env.SANDBOX_MODE = "local";

import { BunRuntime, BunServices } from "@effect/platform-bun";
import {
  ChatMessageRepo,
  ChatThreadRepo,
  storeLayer,
  WorkspaceRepo,
} from "@workspace/db";
import { TaskId, TelegramChatId, type WorkspaceId } from "@workspace/domain";
import { ServerEnv } from "@workspace/env/server";
import { EventLog, telemetryLayer } from "@workspace/telemetry";
import { makeTokenSigner } from "@workspace/token";
import { DateTime, Effect, Layer, Redacted, Schedule } from "effect";
import type { Transformer } from "grammy";
import type { Update } from "grammy/types";
import { registerHandlers } from "../apps/bot/src/index";
import { appLayer, type BotWiring } from "../apps/bot/src/layers";
import { ManagerTurn } from "../apps/bot/src/manager/turn";
import { renderNotice } from "../apps/bot/src/notify";
import { type RunEventSample, stuckVerdict } from "../apps/bot/src/stuck/rule";
import { NOT_ALLOWED_REPLY } from "../apps/bot/src/telegram/access";
import { encodeCallbackData } from "../apps/bot/src/telegram/callback-data";
import { CheckFailed, chatRowsFor, check } from "./bot-check-claims";
import { ensureWorkspace } from "./store/workspace";

/** Reported as `application_name`, so `pg_stat_activity` names this process. */
const SERVICE = "bot-check";

/**
 * A token shaped like a real one and belonging to nobody.
 *
 * `BotService` parses the numeric half into the bot's own id and refuses to build
 * without it, which is the whole reason this is not the empty string. No request
 * ever carries it: the transformer below answers every call before the client
 * reaches the network.
 */
const CHECK_BOT_ID = 900_000_001;
const CHECK_BOT_TOKEN = `${CHECK_BOT_ID}:AAHcheckcheckcheckcheckcheckcheckche`;

/** The account on the allow-list, and one that is not. */
const ALLOWED_TELEGRAM_USER = 700_000_001;
const DENIED_TELEGRAM_USER = 700_000_002;

/** How long a forked update fiber gets to finish before a claim gives up on it. */
const SETTLE_TIMEOUT = "20 seconds";

/** How often the ledger and the database are asked whether it has got there yet. */
const POLL = "100 millis";

/** Seconds in a Telegram `date` field. */
const MS_PER_SECOND = 1000;

/** The ceiling on a made-up `message_id`, which only has to be unique in one run. */
const FAKE_MESSAGE_ID_RANGE = 1_000_000;

/** How many repeated tool calls the stuck window is given. Above the rule's default floor of six. */
const SPINNING_CALLS = 8;

/** The chat id is minted from the clock, kept inside Telegram's signed 32-bit group range. */
const CHAT_ID_RANGE = 1_000_000_000;

/** One Telegram API call this check intercepted instead of making. */
interface ApiCall {
  readonly method: string;
  readonly payload: Record<string, unknown>;
}

/** What `getMe` would have said, so `bot.init()` succeeds with no network. */
const botInfo = {
  can_connect_to_business: false,
  can_join_groups: true,
  can_read_all_group_messages: false,
  first_name: "check",
  has_main_web_app: false,
  id: CHECK_BOT_ID,
  is_bot: true,
  supports_inline_queries: false,
  username: "atm_check_bot",
} as const;

/**
 * What each intercepted call is answered with.
 *
 * Enough shape for grammy to be satisfied and for a handler to read a message id
 * back; not a simulation of Telegram. A method this check never exercises gets
 * `true`, which is what the API returns for most of them anyway.
 */
const apiResultFor = (method: string, payload: Record<string, unknown>) => {
  if (method === "getMe") {
    return botInfo;
  }
  if (method === "sendMessage" || method === "editMessageText") {
    return {
      chat: { id: Number(payload.chat_id ?? 0), type: "private" },
      date: Math.floor(Date.now() / MS_PER_SECOND),
      message_id: Math.floor(Math.random() * FAKE_MESSAGE_ID_RANGE),
      text: String(payload.text ?? ""),
    };
  }
  return true;
};

/**
 * The transformer that stands between the bot and Telegram.
 *
 * Installed before `bot.init()`, so even the identity lookup is answered here —
 * which is what makes the whole check runnable with a token that belongs to
 * nobody. Every call is recorded, because two claims are about what the bot
 * said rather than about what it wrote down.
 */
const recordingTransformer = (calls: ApiCall[]): Transformer =>
  ((_next: unknown, method: string, payload: Record<string, unknown>) => {
    calls.push({ method, payload });
    return Promise.resolve({ ok: true, result: apiResultFor(method, payload) });
  }) as unknown as Transformer;

/**
 * A manager that answers without a container.
 *
 * The real one is a docker daemon, a credential and a model call. What the
 * router needs back from it is the shape of an ending, and that is what this
 * gives: the happy one, with the economics a finished turn reports.
 */
const stubManagerLayer = Layer.succeed(ManagerTurn, {
  run: () =>
    Effect.succeed({
      containerExitCode: 0,
      costUsd: 0.01,
      errorClass: null,
      errorMessage: null,
      outcome: "done" as const,
      providerSessionId: "check-session",
      replyChars: 12,
      toolCalls: 2,
      toolErrors: 0,
      totalTokens: 100,
      turns: 1,
    }),
});

/**
 * The `bot_command` entity Telegram puts on a message that starts with a slash.
 *
 * grammy finds a command by that entity and not by the leading character, so a
 * synthetic `/new` without one reaches the manager as the word "new" — which is
 * exactly the failure the registration order in `index.ts` is about, and would
 * make this check pass for the wrong reason.
 */
const commandEntities = (text: string) => {
  if (!text.startsWith("/")) {
    return;
  }
  const [command = ""] = text.split(" ");
  return [{ length: command.length, offset: 0, type: "bot_command" }];
};

/** A message update as Telegram would deliver it. */
const messageUpdate = (options: {
  readonly chatId: number;
  readonly fromId: number;
  readonly messageId: number;
  readonly text: string;
}) =>
  ({
    message: {
      chat: { first_name: "Check", id: options.chatId, type: "private" },
      date: Math.floor(Date.now() / MS_PER_SECOND),
      entities: commandEntities(options.text),
      from: { first_name: "Check", id: options.fromId, is_bot: false },
      message_id: options.messageId,
      text: options.text,
    },
    update_id: options.messageId,
  }) as Update;

/** A tapped inline button as Telegram would deliver it. */
const callbackUpdate = (options: {
  readonly chatId: number;
  readonly data: string;
  readonly fromId: number;
  readonly messageId: number;
}) =>
  ({
    callback_query: {
      chat_instance: String(options.chatId),
      data: options.data,
      from: { first_name: "Check", id: options.fromId, is_bot: false },
      id: String(options.messageId),
      message: {
        chat: { first_name: "Check", id: options.chatId, type: "private" },
        date: Math.floor(Date.now() / MS_PER_SECOND),
        message_id: options.messageId,
      },
    },
    update_id: options.messageId,
  }) as Update;

/**
 * Waits for something a forked update fiber will make true.
 *
 * The outermost middleware hands the update to a fiber and returns, so
 * `handleUpdate` resolving means the update was accepted rather than answered.
 * Polling is honest about that; sleeping a fixed amount would only hide it.
 */
const eventually = <A, E, R>(options: {
  readonly effect: Effect.Effect<A, E, R>;
  readonly holds: (value: A) => boolean;
  readonly step: string;
}) =>
  options.effect.pipe(
    Effect.filterOrFail(options.holds, () => "not yet"),
    Effect.retry(Schedule.spaced(POLL)),
    Effect.timeoutOrElse({
      duration: SETTLE_TIMEOUT,
      orElse: () =>
        Effect.fail(
          new CheckFailed({
            detail: `nothing satisfied it within ${SETTLE_TIMEOUT}`,
            step: options.step,
          })
        ),
    })
  );

/** The two claims that need neither a database nor a bot. */
const pureClaims = Effect.gen(function* () {
  const rendered = renderNotice({
    notice: {
      costUsd: 0.42,
      durationMs: 61_000,
      errorMessage: null,
      hasLiveRun: false,
      kind: "run_finished",
      lastMessage: "opened the pull request",
      outcome: "done",
      taskId: TaskId.make("019fc000-0000-7000-8000-000000000001"),
      taskStatus: "review",
      taskTitle: "Wire the notification path",
      totalTokens: 4200,
      turns: 3,
    },
    taskUrl: "https://example.test/tasks/1",
  });
  yield* check({
    detail: `rendered ${JSON.stringify(rendered.text.slice(0, 60))}`,
    ok:
      rendered.text.includes("Run finished") &&
      rendered.text.includes("Wire the notification path") &&
      rendered.text.includes("opened the pull request") &&
      rendered.keyboard.inline_keyboard.length > 0,
    step: "a run-finished notice renders with its task, its ending and its buttons",
  });

  const now = yield* DateTime.now;
  const startedAt = DateTime.subtract(now, { minutes: 30 });
  const thresholds = {
    distinctSignatures: 2,
    minToolCalls: 6,
    windowMinutes: 10,
  };
  const toolCall = (options: {
    readonly minutesAgo: number;
    readonly summary: string;
    readonly toolName: string;
  }) =>
    ({
      occurredAt: DateTime.subtract(now, { minutes: options.minutesAgo }),
      payload: {
        callId: `call-${options.minutesAgo}`,
        inputChars: options.summary.length,
        kind: "tool_call",
        summary: options.summary,
        toolName: options.toolName,
      },
    }) satisfies RunEventSample;

  const spinning = Array.from({ length: SPINNING_CALLS }, (_, index) =>
    toolCall({
      minutesAgo: SPINNING_CALLS - index,
      summary: "ls packages",
      toolName: "Bash",
    })
  );
  const verdict = stuckVerdict({
    events: spinning,
    now,
    startedAt,
    thresholds,
  });
  yield* check({
    detail: `the rule said ${verdict.kind}`,
    ok: verdict.kind === "stuck" && verdict.signatures.length === 1,
    step: "the stuck rule fires on a window of repeated calls with no file edit",
  });

  const withEdit = stuckVerdict({
    events: [
      ...spinning,
      toolCall({ minutesAgo: 1, summary: "src/main.ts", toolName: "Edit" }),
    ],
    now,
    startedAt,
    thresholds,
  });
  yield* check({
    detail: `the rule said ${withEdit.kind}`,
    ok: withEdit.kind === "working" && withEdit.reason === "edited_files",
    step: "the same window with one file edit in it is a run that is working",
  });
});

/** The three claims that need the whole bot standing up. */
const wiredClaims = (options: {
  readonly chatId: number;
  readonly wiring: BotWiring;
  readonly workspaceId: WorkspaceId;
}) =>
  Effect.gen(function* () {
    const { chatId, workspaceId } = options;
    const ledger = yield* EventLog;
    const messages = yield* ChatMessageRepo;
    const threads = yield* ChatThreadRepo;

    const calls: ApiCall[] = [];
    const { telegram } = yield* registerHandlers(options.wiring);
    telegram.bot.api.config.use(recordingTransformer(calls));
    yield* Effect.promise(() => telegram.bot.init());

    const chatRef = { chatId: TelegramChatId.make(chatId), workspaceId };
    const rowsHere = () =>
      Effect.sync(() => chatRowsFor({ chatId, path: ledger.path }));

    // The door.
    yield* Effect.promise(() =>
      telegram.bot.handleUpdate(
        messageUpdate({
          chatId,
          fromId: DENIED_TELEGRAM_USER,
          messageId: 1,
          text: "let me in",
        })
      )
    );
    const denied = yield* eventually({
      effect: rowsHere(),
      holds: (rows) => rows.some((row) => row.outcome === "not_allowed"),
      step: "a refused account leaves a row",
    });
    const refusal = denied.find((row) => row.outcome === "not_allowed");
    yield* check({
      detail: `the row says userId ${String(refusal?.userId)}`,
      ok: refusal?.userId === null && refusal?.workspaceId === null,
      step: "an account nobody allow-listed leaves one atm.chat row and no identity",
    });
    yield* check({
      detail: `the bot said ${JSON.stringify(calls.at(-1)?.payload.text)}`,
      ok: calls.some((call) => call.payload.text === NOT_ALLOWED_REPLY),
      step: "the refused account is told so, once",
    });

    // The conversation.
    const said = "file a task about the check";
    yield* Effect.promise(() =>
      telegram.bot.handleUpdate(
        messageUpdate({
          chatId,
          fromId: ALLOWED_TELEGRAM_USER,
          messageId: 2,
          text: said,
        })
      )
    );
    const opened = yield* eventually({
      effect: threads.current(chatRef),
      holds: (thread) => thread !== null,
      step: "a text message opens a conversation",
    });
    if (opened === null) {
      return yield* Effect.fail(
        new CheckFailed({
          detail: "no current thread",
          step: "a text message opens a conversation",
        })
      );
    }
    yield* check({
      detail: `thread ${opened.id} on ${opened.provider}`,
      ok: opened.isCurrent && opened.workspaceId === workspaceId,
      step: "a text message opens the chat's current conversation",
    });

    const stored = yield* eventually({
      effect: messages.recent({
        limit: 10,
        threadId: opened.id,
        workspaceId,
      }),
      holds: (rows) => rows.some((row) => row.body === said),
      step: "the message is stored before the turn runs",
    });
    const userRow = stored.find((row) => row.body === said);
    yield* check({
      detail: `role ${String(userRow?.role)}, intake ${String(userRow?.intakeKind)}`,
      ok: userRow?.role === "user" && userRow?.intakeKind === "text",
      step: "the message is stored as the person's own turn",
    });

    const answered = yield* eventually({
      effect: rowsHere(),
      holds: (rows) =>
        rows.some(
          (row) => row.threadId === opened.id && row.updateKind === "text"
        ),
      step: "the answered message leaves a row naming its conversation",
    });
    const turnRow = answered.find((row) => row.threadId === opened.id);
    yield* check({
      detail: `outcome ${String(turnRow?.outcome)}, promptChars ${String(turnRow?.promptChars)}`,
      ok: turnRow?.outcome === "done" && (turnRow?.promptChars ?? 0) > 0,
      step: "the row carries the ending and the size of what was asked",
    });

    // The switch.
    yield* Effect.promise(() =>
      telegram.bot.handleUpdate(
        messageUpdate({
          chatId,
          fromId: ALLOWED_TELEGRAM_USER,
          messageId: 3,
          text: "/new",
        })
      )
    );
    const second = yield* eventually({
      effect: threads.current(chatRef),
      holds: (thread) => thread !== null && thread.id !== opened.id,
      step: "/new opens a second conversation and takes over",
    });
    yield* check({
      detail: `current is ${String(second?.id)}`,
      ok: second !== null && second.id !== opened.id,
      step: "/new makes a fresh conversation the current one",
    });

    yield* Effect.promise(() =>
      telegram.bot.handleUpdate(
        callbackUpdate({
          chatId,
          data: encodeCallbackData({
            kind: "thread",
            threadId: opened.id,
            verb: "thsw",
          }),
          fromId: ALLOWED_TELEGRAM_USER,
          messageId: 4,
        })
      )
    );
    yield* eventually({
      effect: threads.current(chatRef),
      holds: (thread) => thread !== null && thread.id === opened.id,
      step: "a Switch button makes the first conversation current again",
    });
    yield* check({
      detail: `back on ${opened.id}`,
      ok: true,
      step: "a Switch button makes the first conversation current again",
    });

    const tapped = yield* rowsHere();
    yield* check({
      detail: `kinds seen: ${[...new Set(tapped.map((row) => row.updateKind))].join(", ")}`,
      ok: tapped.some((row) => row.updateKind === "callback"),
      step: "the tap leaves a row of its own, classified as a callback",
    });
  });

/**
 * The allow-list this check answers, built from the workspace that was just
 * ensured rather than from the environment.
 *
 * The bot parses this exact format at boot; handing it a string is what keeps
 * the parse in the claim instead of around it.
 */
const allowlistFor = (options: {
  readonly ownerId: string;
  readonly workspaceId: WorkspaceId;
}) => `${ALLOWED_TELEGRAM_USER}:${options.workspaceId}:${options.ownerId}`;

/** The workspace, its owner, and the resolved environment the layers are built on. */
const bootstrap = Effect.gen(function* () {
  const { owner, workspace } = yield* ensureWorkspace();
  const env = yield* ServerEnv;
  const signer = yield* makeTokenSigner;
  return {
    ownerId: owner,
    signer,
    wiring: {
      allowlist: allowlistFor({ ownerId: owner, workspaceId: workspace.id }),
      botToken: Redacted.make(CHECK_BOT_TOKEN),
      env,
      signer,
    } satisfies BotWiring,
    workspaceId: workspace.id,
  };
}).pipe(
  Effect.provide(
    Layer.mergeAll(
      ServerEnv.layer,
      WorkspaceRepo.layer.pipe(
        Layer.provideMerge(storeLayer({ applicationName: SERVICE }))
      )
    ).pipe(
      Layer.provideMerge(
        telemetryLayer({ serviceName: SERVICE }).pipe(
          Layer.provideMerge(BunServices.layer)
        )
      )
    )
  )
);

const botCheck = Effect.gen(function* () {
  yield* Effect.logInfo(
    `${SERVICE}: no telegram token, no telegram call, no container — data root ${CHECK_ROOT}`
  );
  yield* pureClaims;

  const booted = yield* bootstrap;
  // A fresh chat per invocation: two runs of this check must not read each
  // other's conversation, and there is no delete on a thread to clean up with.
  const chatId = -1 * (Date.now() % CHAT_ID_RANGE);

  yield* wiredClaims({
    chatId,
    wiring: booted.wiring,
    workspaceId: booted.workspaceId,
  }).pipe(
    Effect.provide(appLayer(booted.wiring, stubManagerLayer)),
    Effect.scoped
  );

  yield* Effect.logInfo(
    `every claim held; read the updates back with EVENT_LOG_DIR=${CHECK_EVENT_DIR} bun run logs`
  );
});

BunRuntime.runMain(botCheck);
