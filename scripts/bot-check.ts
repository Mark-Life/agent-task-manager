#!/usr/bin/env bun

/**
 * Proves what Phase 6 exits on, without a Telegram token and without one call to
 * Telegram.
 *
 * The bot's own handlers are registered exactly as `apps/bot/src/index.ts`
 * registers them, on a real grammy `Bot`, and driven with synthetic updates
 * through `bot.handleUpdate` — the same entry point long polling uses. What is
 * substituted is the three things that would leave the machine: every Telegram
 * API call is answered by a transformer installed on `bot.api`, so `getMe`, a
 * reply and a callback answer are recorded rather than sent; the board client is
 * a layer that records the calls a tapped button makes, because the gateway is a
 * second process; and the transcriber hears one fixed sentence, because Groq is
 * a paid API and what the voice claim is about is where the words end up.
 *
 * Nothing here runs an agent, and after the cut nothing in `apps/bot` can: a
 * message becomes a `chat_message` row, the insert trigger wakes the
 * orchestrator, and the answer comes back as another row. The turns this check
 * needs are therefore written straight into the store, exactly as the loop
 * writes them.
 *
 * Everything else is the real thing. A real Postgres, the real allow-list parse,
 * the real access gate, the real router, the real thread repository, and the
 * real `atm.chat` ledger read back off the disk.
 *
 * The claims:
 *
 * **The door.** An account nobody allow-listed is refused with one sentence and
 * leaves one row saying `not_allowed` with no user on it. A refusal that vanishes
 * is the one failure nobody could count.
 *
 * **The conversation.** A text message from an allow-listed account opens a
 * thread, stores the message, and leaves a row naming the thread.
 *
 * **The voice note.** A voice message comes back as the words that were heard
 * in it, and is stored as the transcript. The sender of a voice note has no
 * other way to see what arrived.
 *
 * **Compose.** A text, a forward and a voice note sent after `/compose` leave
 * no `chat_message` row and wake nothing; the *Send* button then writes exactly
 * one, holding all three in the order they were sent and naming where the
 * forward came from. *Cancel* writes none. Both leave the mode off, which the
 * next ordinary message proves by becoming a turn of its own.
 *
 * **The queue.** A message sent while the thread has a live turn is stored all
 * the same and answered with one line carrying a *Force send* button; a second
 * one edits that same line instead of sending another, which is what "several
 * queued messages coalesce" looks like from the chat.
 *
 * **The force send.** Tapping the button files a stop naming the thread — the
 * same queue a human's Stop on a task goes through, and the only way this
 * process can end a turn.
 *
 * **The answer.** A turn that is still closing itself out is waited for, and its
 * row is delivered into the conversation with the queued line taken down beside
 * it — never as "the turn ended without an answer".
 *
 * **The switch.** `/new` opens a second conversation and takes over as current;
 * a *Switch* button on the first makes it current again — the callback decoded
 * through its schema, not cast out of the update.
 *
 * **The notice.** A finished run renders into a message a person can read, with
 * the buttons its task's status earns.
 *
 * **The restart.** A process start puts one line into the allow-listed chat —
 * resolved from the allow-list, because there is no task to trace a
 * conversation from — and a second start inside the quiet window adds nothing,
 * which is the whole defence against a crash loop. A graceful stop leaves the
 * row the next start reads back, so the line it sends says how long the system
 * was down and that it was stopped on purpose rather than lost.
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

import { BunRuntime, BunServices } from "@effect/platform-bun";
import {
  AgentSessionRepo,
  ChatMessageRepo,
  ChatNotificationRepo,
  ChatThreadRepo,
  RunRepo,
  storeLayer,
  WorkspaceRepo,
  withActor,
} from "@workspace/db";
import {
  Actor,
  type RunId,
  TaskId,
  TelegramChatId,
  type ThreadId,
  type WorkspaceId,
} from "@workspace/domain";
import { ServerEnv } from "@workspace/env/server";
import { EventLog, telemetryLayer } from "@workspace/telemetry";
import { makeTokenSigner } from "@workspace/token";
import type { Context } from "effect";
import { DateTime, Effect, Layer, Redacted, Schedule } from "effect";
import type { Transformer } from "grammy";
import type { Update } from "grammy/types";
import { registerHandlers } from "../apps/bot/src/index";
import { appLayer, type BotWiring } from "../apps/bot/src/layers";
import {
  announceShutdown,
  announceStartup,
  renderNotice,
} from "../apps/bot/src/notify";
import { type RunEventSample, stuckVerdict } from "../apps/bot/src/stuck/rule";
import { NOT_ALLOWED_REPLY } from "../apps/bot/src/telegram/access";
import {
  deliverAnswer,
  FORCE_SEND_LABEL,
} from "../apps/bot/src/telegram/answer";
import { Board } from "../apps/bot/src/telegram/board";
import { encodeCallbackData } from "../apps/bot/src/telegram/callback-data";
import { TranscribeService } from "../apps/bot/src/transcribe";
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

/**
 * How long the answer claim leaves the turn mid-close before writing what it
 * said. Longer than one read of the run row, so a delivery that did not wait
 * cannot pass by luck.
 */
const ANSWER_WRITE_DELAY = "1500 millis";

/** How often the ledger and the database are asked whether it has got there yet. */
const POLL = "100 millis";

/** Seconds in a Telegram `date` field. */
const MS_PER_SECOND = 1000;

/** The ceiling on a made-up `message_id`, which only has to be unique in one run. */
const FAKE_MESSAGE_ID_RANGE = 1_000_000;

/** How many repeated tool calls the stuck window is given. Above the rule's default floor of six. */
const SPINNING_CALLS = 8;

/** How much of a body a claim's `detail` quotes back, so a failure names what it saw. */
const DETAIL_PREVIEW_CHARS = 80;

/** How far back a compose claim reads the thread. Above every row this check writes. */
const THREAD_LOOKBACK = 50;

/** The chat id is minted from the clock, kept inside Telegram's signed 32-bit group range. */
const CHAT_ID_RANGE = 1_000_000_000;

/** A window wide enough that two announcements a millisecond apart are inside it. */
const QUIET_WINDOW_MS = 900_000;

/** What this check tells the announcement it is running, so the line carries something. */
const CHECK_BUILD = "checksha";

/** What `getFile` answers for the voice note this check sends. */
const VOICE_FILE_PATH = "voice/file_1.oga";

/** What the stand-in transcriber hears in it. */
const VOICE_TRANSCRIPT = "test, test, one, two, three";

/**
 * The "audio" the file download answers with. A few bytes: nothing decodes
 * them, because the transcriber that would is substituted too.
 */
const VOICE_FILE_BYTES = new TextEncoder().encode("ogg");

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
  if (method === "getFile") {
    return {
      file_id: String(payload.file_id ?? ""),
      file_path: VOICE_FILE_PATH,
    };
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
 * A transcriber that hears one fixed sentence.
 *
 * Groq is a paid API and a key this deployment may not hold, and what the claim
 * is about is not Whisper's accuracy — it is that whatever came back reaches
 * the chat the voice note was sent from.
 */
const stubTranscribeLayer = Layer.succeed(TranscribeService, {
  available: true,
  transcribe: () =>
    Effect.succeed({
      chars: VOICE_TRANSCRIPT.length,
      durationMs: 42,
      text: VOICE_TRANSCRIPT,
    }),
} as unknown as Context.Service.Shape<typeof TranscribeService>);

/**
 * The one HTTP call `apps/bot` makes outside grammy: the voice file behind a
 * file id. Every other URL goes to the real fetch, so nothing else this process
 * does is affected, and the swap is released with the scope that took it.
 */
const withVoiceFileFetch = Effect.acquireRelease(
  Effect.sync(() => {
    const real = globalThis.fetch;
    globalThis.fetch = ((input: unknown, init?: unknown) => {
      const url = String(
        input instanceof Request ? input.url : (input as string | URL)
      );
      return url.includes("/file/bot")
        ? Promise.resolve(new Response(VOICE_FILE_BYTES))
        : (real as (a: unknown, b?: unknown) => Promise<Response>)(input, init);
    }) as typeof globalThis.fetch;
    return real;
  }),
  (real) =>
    Effect.sync(() => {
      globalThis.fetch = real;
    })
);

/** One board call this check intercepted instead of making. */
interface BoardCall {
  readonly operation: string;
  readonly target: string;
}

/**
 * A board that records instead of calling.
 *
 * The gateway is a second process with its own check. What is being claimed
 * here is what the bot *asks* for when a button is tapped — which thread it
 * names, and that it goes through the run-command queue at all rather than
 * reaching a container.
 */
const stubBoardLayer = (calls: BoardCall[]) => {
  const record =
    (operation: string) =>
    <A>(input: { readonly taskId?: string; readonly threadId?: string }) =>
      Effect.sync(() => {
        calls.push({
          operation,
          target: input.threadId ?? input.taskId ?? "",
        });
        return { rejectedReason: null } as A;
      });
  const board = {
    addComment: record("addComment"),
    columns: record("columns"),
    listTasks: record("listTasks"),
    moveTask: record("moveTask"),
    placeTask: record("placeTask"),
    rerunTask: record("rerunTask"),
    stopRun: record("stopRun"),
    stopThread: record("stopThread"),
    taskDetail: record("taskDetail"),
  } as unknown as Context.Service.Shape<typeof Board>;
  return Layer.succeed(Board, board);
};

/**
 * A turn on a thread, written the way the orchestrator writes one.
 *
 * `apps/bot` cannot open a run and must not be able to: the session and the run
 * row are the loop's, and the bot's own store hands it no actor to write them
 * with. So this check opens its own connection under the orchestrator actor —
 * which is exactly what it is standing in for.
 */
const openTurn = (input: {
  readonly threadId: ThreadId;
  readonly workspaceId: WorkspaceId;
}) =>
  Effect.gen(function* () {
    const runs = yield* RunRepo;
    const sessions = yield* AgentSessionRepo;
    const asLoop = withActor(
      Actor.cases.orchestrator.make({ loopInstance: SERVICE })
    );
    const subject = { id: input.threadId, kind: "thread" } as const;
    const session = yield* asLoop(
      sessions.open({
        provider: "claude",
        subject,
        workspaceId: input.workspaceId,
      })
    );
    const run = yield* asLoop(
      runs.create({
        agentSessionId: session.id,
        provider: "claude",
        subject,
        trigger: "manual",
        workspaceId: input.workspaceId,
      })
    );
    yield* asLoop(runs.start({ id: run.id, workspaceId: input.workspaceId }));
    return run;
  });

/** The same turn, ended — what a terminal run event means. */
const closeTurn = (input: {
  readonly runId: RunId;
  readonly workspaceId: WorkspaceId;
}) =>
  Effect.gen(function* () {
    const runs = yield* RunRepo;
    yield* withActor(Actor.cases.orchestrator.make({ loopInstance: SERVICE }))(
      runs.close({
        durationMs: 1200,
        id: input.runId,
        outcome: "done",
        totalTokens: 4096,
        turns: 1,
        workspaceId: input.workspaceId,
      })
    );
  });

/** The store this check writes a turn with, separate from the bot's own. */
const turnStoreLayer = Layer.mergeAll(
  AgentSessionRepo.layer,
  RunRepo.layer
).pipe(Layer.provideMerge(storeLayer({ applicationName: SERVICE })));

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

/** A message update as Telegram would deliver it, forwarded when it says so. */
const messageUpdate = (options: {
  readonly chatId: number;
  readonly forwardedFrom?: string;
  readonly fromId: number;
  readonly messageId: number;
  readonly text: string;
}) =>
  ({
    message: {
      chat: { first_name: "Check", id: options.chatId, type: "private" },
      date: Math.floor(Date.now() / MS_PER_SECOND),
      entities: commandEntities(options.text),
      ...(options.forwardedFrom === undefined
        ? {}
        : {
            forward_origin: {
              date: 0,
              sender_user: {
                first_name: options.forwardedFrom,
                id: 1,
                is_bot: false,
              },
              type: "user",
            },
          }),
      from: { first_name: "Check", id: options.fromId, is_bot: false },
      message_id: options.messageId,
      text: options.text,
    },
    update_id: options.messageId,
  }) as Update;

/** A voice note as Telegram would deliver it. */
const voiceUpdate = (options: {
  readonly chatId: number;
  readonly fromId: number;
  readonly messageId: number;
}) =>
  ({
    message: {
      chat: { first_name: "Check", id: options.chatId, type: "private" },
      date: Math.floor(Date.now() / MS_PER_SECOND),
      from: { first_name: "Check", id: options.fromId, is_bot: false },
      message_id: options.messageId,
      voice: { duration: 3, file_id: "AgADvoice", file_unique_id: "u" },
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

/**
 * What the bot says about itself, driven as the process lifetime drives it.
 *
 * The quiet window is zero for the claims about *what* it says, because this
 * check shares a workspace with every previous run of it and a fifteen-minute
 * window would make them depend on when it was last run. The suppression gets
 * its own pair of calls, where that history cannot lend a false pass: whatever
 * the first one decides, the second must add nothing.
 */
const restartClaims = (options: {
  readonly calls: ApiCall[];
  readonly workspaceId: WorkspaceId;
}) =>
  Effect.gen(function* () {
    const { calls, workspaceId } = options;
    const notifications = yield* ChatNotificationRepo;
    const announce = { build: CHECK_BUILD, quietMs: 0 };
    const said = (text: string) => (call: ApiCall) =>
      String(call.payload.text ?? "").includes(text);

    const beforeUp = calls.length;
    yield* announceStartup(announce);
    const restartLine = calls.slice(beforeUp).find(said("System restarted"));
    yield* check({
      detail: `the bot said ${JSON.stringify(restartLine?.payload.text)}`,
      ok: restartLine !== undefined,
      step: "a process start announces itself without being asked",
    });
    yield* check({
      detail: `it went to chat ${String(restartLine?.payload.chat_id)}`,
      ok: Number(restartLine?.payload.chat_id) === ALLOWED_TELEGRAM_USER,
      step: "the announcement is addressed from the allow-list, with no task to trace",
    });

    // The claim is what suppresses the next one, so it has to be on the ledger
    // — with no task on it, which is the column the migration made nullable.
    const claimed = yield* notifications.newestOfKind({
      kind: "system_up",
      workspaceId,
    });
    yield* check({
      detail: `the ledger holds ${String(claimed?.dedupeKey)} with taskId ${String(claimed?.taskId)}`,
      ok:
        claimed !== null && claimed.taskId === null && claimed.sentAt !== null,
      step: "the announcement is a delivered claim on the ledger, naming no task",
    });

    const quiet = { build: CHECK_BUILD, quietMs: QUIET_WINDOW_MS };
    yield* announceStartup(quiet);
    const afterFirst = calls.length;
    yield* announceStartup(quiet);
    yield* check({
      detail: `${calls.length - afterFirst} message(s) sent by the second start`,
      ok: calls.length === afterFirst,
      step: "a second start inside the quiet window says nothing at all",
    });

    // The stop, and what the start after it can say because of it.
    const beforeDown = calls.length;
    yield* announceShutdown(announce);
    const goingDown = calls.slice(beforeDown).find(said("System going down"));
    yield* check({
      detail: `the bot said ${JSON.stringify(goingDown?.payload.text)}`,
      ok: goingDown !== undefined,
      step: "a graceful stop says so before it goes",
    });

    const beforeBack = calls.length;
    yield* announceStartup(announce);
    const backUp = calls.slice(beforeBack).find(said("System restarted"));
    const backUpText = String(backUp?.payload.text ?? "");
    yield* check({
      detail: `the bot said ${JSON.stringify(backUpText)}`,
      ok:
        backUpText.includes("down for") &&
        !backUpText.includes("crash or a hard reboot"),
      step: "the start after a graceful stop reports the downtime rather than a crash",
    });
  });

/** The claims that need the whole bot standing up. */
const wiredClaims = (options: {
  readonly boardCalls: BoardCall[];
  readonly chatId: number;
  readonly wiring: BotWiring;
  readonly workspaceId: WorkspaceId;
}) =>
  Effect.gen(function* () {
    const { boardCalls, chatId, workspaceId } = options;
    const ledger = yield* EventLog;
    const messages = yield* ChatMessageRepo;
    const threads = yield* ChatThreadRepo;

    const calls: ApiCall[] = [];
    const { notices, telegram } = yield* registerHandlers(options.wiring);
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
      step: "the message is stored, which is what wakes the orchestrator",
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
      step: "the accepted message leaves a row naming its conversation",
    });
    const turnRow = answered.find((row) => row.threadId === opened.id);
    yield* check({
      detail: `outcome ${String(turnRow?.outcome)}, promptChars ${String(turnRow?.promptChars)}`,
      ok: turnRow?.outcome === "done" && (turnRow?.promptChars ?? 0) > 0,
      step: "the row carries the ending and the size of what was asked",
    });
    yield* check({
      detail: `costUsd ${String(turnRow?.costUsd)}, totalTokens ${String(turnRow?.totalTokens)}`,
      ok: turnRow?.costUsd === null && turnRow?.totalTokens === null,
      step: "the row spends nothing: what a turn costs is the turn's own row",
    });

    // The voice note. Sent before a turn is live on the thread, so what comes
    // back is the echo and nothing else.
    const beforeVoice = calls.length;
    yield* Effect.promise(() =>
      telegram.bot.handleUpdate(
        voiceUpdate({
          chatId,
          fromId: ALLOWED_TELEGRAM_USER,
          messageId: 4,
        })
      )
    );
    const echoed = yield* eventually({
      effect: Effect.sync(() => calls.slice(beforeVoice)),
      holds: (since) =>
        since.some((call) =>
          String(call.payload.text ?? "").includes(VOICE_TRANSCRIPT)
        ),
      step: "a voice note is answered with what was heard in it",
    });
    yield* check({
      detail: `the bot said ${JSON.stringify(echoed.find((call) => String(call.payload.text ?? "").includes(VOICE_TRANSCRIPT))?.payload.text)}`,
      ok: echoed.some((call) =>
        String(call.payload.text ?? "").includes(VOICE_TRANSCRIPT)
      ),
      step: "the transcript comes back into the chat the voice note came from",
    });
    const spokenRow = yield* eventually({
      effect: messages.recent({ limit: 10, threadId: opened.id, workspaceId }),
      holds: (rows) => rows.some((row) => row.body === VOICE_TRANSCRIPT),
      step: "the transcript is stored as the person's turn",
    });
    const voiceRow = spokenRow.find((row) => row.body === VOICE_TRANSCRIPT);
    yield* check({
      detail: `intake ${String(voiceRow?.intakeKind)}, transcriptChars ${String(voiceRow?.transcriptChars)}`,
      ok:
        voiceRow?.intakeKind === "voice" &&
        voiceRow?.transcriptChars === VOICE_TRANSCRIPT.length,
      step: "the stored row says it was a voice note and how long the transcript was",
    });

    // Compose. Several messages in a row produce no turn at all, and the button
    // produces exactly one — which is the whole claim, because the failure mode
    // on either side of it is invisible: a message that quietly ran a turn
    // anyway, or a batch that quietly ran three.
    const composeSendData = encodeCallbackData({
      kind: "compose",
      verb: "cmsnd",
    });
    const composeCancelData = encodeCallbackData({
      kind: "compose",
      verb: "cmcxl",
    });
    const carries = (call: ApiCall, data: string) =>
      JSON.stringify(call.payload.reply_markup ?? {}).includes(data);
    const rowsInThread = () =>
      messages.recent({
        limit: THREAD_LOOKBACK,
        threadId: opened.id,
        workspaceId,
      });

    const beforeCompose = (yield* rowsInThread()).length;
    const beforeComposeCall = calls.length;
    yield* Effect.promise(() =>
      telegram.bot.handleUpdate(
        messageUpdate({
          chatId,
          fromId: ALLOWED_TELEGRAM_USER,
          messageId: 30,
          text: "/compose",
        })
      )
    );
    yield* eventually({
      effect: Effect.sync(() => calls.slice(beforeComposeCall)),
      holds: (since) =>
        since.some(
          (call) =>
            call.method === "sendMessage" && carries(call, composeSendData)
        ),
      step: "/compose answers with a message carrying its own two buttons",
    });
    const composeAnchor = calls
      .slice(beforeComposeCall)
      .find(
        (call) =>
          call.method === "sendMessage" && carries(call, composeSendData)
      );
    yield* check({
      detail: `the bot said ${JSON.stringify(composeAnchor?.payload.text)}`,
      ok: carries(
        composeAnchor ?? { method: "", payload: {} },
        composeCancelData
      ),
      step: "the compose message offers both send and cancel",
    });

    const composedText = "first, the thing I actually want";
    const composedForward = "and the message somebody sent me about it";
    for (const update of [
      messageUpdate({
        chatId,
        fromId: ALLOWED_TELEGRAM_USER,
        messageId: 31,
        text: composedText,
      }),
      messageUpdate({
        chatId,
        forwardedFrom: "Ada",
        fromId: ALLOWED_TELEGRAM_USER,
        messageId: 32,
        text: composedForward,
      }),
      voiceUpdate({ chatId, fromId: ALLOWED_TELEGRAM_USER, messageId: 33 }),
    ]) {
      yield* Effect.promise(() => telegram.bot.handleUpdate(update));
    }

    // Three held is the only signal that all three arrived; waiting on a fixed
    // sleep here would let a message that started a turn pass unnoticed.
    yield* eventually({
      effect: Effect.sync(() => calls.slice(beforeComposeCall)),
      holds: (since) =>
        since.some(
          (call) =>
            call.method === "editMessageText" &&
            String(call.payload.text ?? "").includes("3 messages held")
        ),
      step: "each message sent into compose is counted on the compose message",
    });
    yield* check({
      detail: `the transcript ${VOICE_TRANSCRIPT} came back ${calls.slice(beforeComposeCall).filter((call) => String(call.payload.text ?? "").includes(VOICE_TRANSCRIPT)).length} time(s)`,
      ok: calls
        .slice(beforeComposeCall)
        .some((call) =>
          String(call.payload.text ?? "").includes(VOICE_TRANSCRIPT)
        ),
      step: "a voice note sent into compose is still transcribed and echoed back",
    });

    const heldRows = yield* rowsInThread();
    yield* check({
      detail: `${heldRows.length - beforeCompose} rows written while composing`,
      ok: heldRows.length === beforeCompose,
      step: "nothing sent into compose is stored, so nothing wakes the orchestrator",
    });

    yield* Effect.promise(() =>
      telegram.bot.handleUpdate(
        callbackUpdate({
          chatId,
          data: composeSendData,
          fromId: ALLOWED_TELEGRAM_USER,
          messageId: 34,
        })
      )
    );
    const afterSend = yield* eventually({
      effect: rowsInThread(),
      holds: (rows) => rows.length > beforeCompose,
      step: "the send button writes the batch",
    });
    yield* check({
      detail: `${afterSend.length - beforeCompose} rows written by the tap`,
      ok: afterSend.length === beforeCompose + 1,
      step: "the whole batch is one row, which is one insert and one turn",
    });
    const batch = afterSend.find((row) => row.intakeKind === "compose");
    yield* check({
      detail: `intake ${String(batch?.intakeKind)}, ${String(batch?.body.length)} chars`,
      ok:
        batch !== undefined &&
        batch.body.indexOf(composedText) <
          batch.body.indexOf(composedForward) &&
        batch.body.indexOf(composedForward) <
          batch.body.indexOf(VOICE_TRANSCRIPT),
      step: "the row holds every message it collected, in the order they were sent",
    });
    yield* check({
      detail: `the body says ${JSON.stringify(batch?.body.slice(0, DETAIL_PREVIEW_CHARS))}`,
      ok: batch?.body.includes("forwarded from Ada") === true,
      step: "a forward keeps the name it came from, inside the combined text",
    });

    // Off again, which is what makes the next ordinary message an ordinary
    // message rather than the first of a batch nobody opened.
    const said2 = "and this one on its own";
    yield* Effect.promise(() =>
      telegram.bot.handleUpdate(
        messageUpdate({
          chatId,
          fromId: ALLOWED_TELEGRAM_USER,
          messageId: 35,
          text: said2,
        })
      )
    );
    yield* eventually({
      effect: rowsInThread(),
      holds: (rows) => rows.some((row) => row.body === said2),
      step: "compose is off after the send, so the next message is its own turn",
    });
    yield* check({
      detail: "the message after the batch was stored on its own",
      ok: true,
      step: "compose is off after the send, so the next message is its own turn",
    });

    // And the other button: collected, then dropped, with nothing written.
    const beforeCancel = (yield* rowsInThread()).length;
    const beforeCancelCall = calls.length;
    for (const update of [
      messageUpdate({
        chatId,
        fromId: ALLOWED_TELEGRAM_USER,
        messageId: 36,
        text: "/compose",
      }),
      messageUpdate({
        chatId,
        fromId: ALLOWED_TELEGRAM_USER,
        messageId: 37,
        text: "never mind this one",
      }),
    ]) {
      yield* Effect.promise(() => telegram.bot.handleUpdate(update));
    }
    yield* eventually({
      effect: Effect.sync(() => calls.slice(beforeCancelCall)),
      holds: (since) =>
        since.some(
          (call) =>
            call.method === "editMessageText" &&
            String(call.payload.text ?? "").includes("1 message held")
        ),
      step: "the second compose collects again",
    });
    yield* Effect.promise(() =>
      telegram.bot.handleUpdate(
        callbackUpdate({
          chatId,
          data: composeCancelData,
          fromId: ALLOWED_TELEGRAM_USER,
          messageId: 38,
        })
      )
    );
    yield* eventually({
      effect: Effect.sync(() => calls.slice(beforeCancelCall)),
      holds: (since) =>
        since.some((call) =>
          String(call.payload.text ?? "").includes("discarded")
        ),
      step: "cancel says what it dropped",
    });
    const afterCancel = yield* rowsInThread();
    yield* check({
      detail: `${afterCancel.length - beforeCancel} rows written across the cancelled batch`,
      ok: afterCancel.length === beforeCancel,
      step: "a cancelled batch reaches neither the conversation nor a turn",
    });

    // The queue. A turn is opened the way the loop opens one, because after the
    // cut this process cannot.
    const turn = yield* openTurn({
      threadId: opened.id,
      workspaceId,
    }).pipe(Effect.provide(turnStoreLayer));

    const before = calls.length;
    yield* Effect.promise(() =>
      telegram.bot.handleUpdate(
        messageUpdate({
          chatId,
          fromId: ALLOWED_TELEGRAM_USER,
          messageId: 20,
          text: "and one more thing",
        })
      )
    );
    const forceSendData = encodeCallbackData({
      kind: "thread",
      threadId: opened.id,
      verb: "thfs",
    });
    const hasForceSend = (call: ApiCall) =>
      JSON.stringify(call.payload.reply_markup ?? {}).includes(forceSendData);

    yield* eventually({
      effect: Effect.sync(() => calls.slice(before)),
      holds: (since) =>
        since.some(
          (call) => call.method === "sendMessage" && hasForceSend(call)
        ),
      step: "a message sent mid-turn is answered with the Force send button",
    });
    const queuedLine = calls
      .slice(before)
      .find((call) => call.method === "sendMessage" && hasForceSend(call));
    yield* check({
      detail: `the bot said ${JSON.stringify(queuedLine?.payload.text)}`,
      ok:
        String(queuedLine?.payload.text ?? "").includes("queued") &&
        JSON.stringify(queuedLine?.payload.reply_markup).includes(
          FORCE_SEND_LABEL
        ),
      step: "the queued line names the button that would stop the turn",
    });

    const stored2 = yield* messages.recent({
      limit: 10,
      threadId: opened.id,
      workspaceId,
    });
    yield* check({
      detail: `${stored2.filter((row) => row.role === "user").length} user rows in the thread`,
      ok: stored2.some((row) => row.body === "and one more thing"),
      step: "the queued message is stored all the same, so the next turn reads it",
    });

    const beforeSecond = calls.length;
    yield* Effect.promise(() =>
      telegram.bot.handleUpdate(
        messageUpdate({
          chatId,
          fromId: ALLOWED_TELEGRAM_USER,
          messageId: 21,
          text: "and another",
        })
      )
    );
    const coalesced = yield* eventually({
      effect: Effect.sync(() => calls.slice(beforeSecond)),
      holds: (since) => since.some((call) => call.method === "editMessageText"),
      step: "a second queued message edits the line rather than sending another",
    });
    yield* check({
      detail: `${coalesced.filter((call) => call.method === "sendMessage" && hasForceSend(call)).length} extra queued lines sent`,
      ok:
        coalesced.every(
          (call) => !(call.method === "sendMessage" && hasForceSend(call))
        ) &&
        String(
          coalesced.find((call) => call.method === "editMessageText")?.payload
            .text ?? ""
        ).includes("2 messages"),
      step: "several queued messages coalesce into one line saying how many wait",
    });

    // The force send.
    const beforeTap = boardCalls.length;
    yield* Effect.promise(() =>
      telegram.bot.handleUpdate(
        callbackUpdate({
          chatId,
          data: forceSendData,
          fromId: ALLOWED_TELEGRAM_USER,
          messageId: 22,
        })
      )
    );
    const stopped = yield* eventually({
      effect: Effect.sync(() => boardCalls.slice(beforeTap)),
      holds: (since) => since.some((call) => call.operation === "stopThread"),
      step: "Force send asks the board to stop the turn",
    });
    yield* check({
      detail: `it named ${String(stopped.find((call) => call.operation === "stopThread")?.target)}`,
      ok: stopped.some(
        (call) => call.operation === "stopThread" && call.target === opened.id
      ),
      step: "the stop names the conversation, not a task and not a container",
    });

    // The answer, delivered against a turn that is still closing itself out.
    //
    // This is the order the loop writes in and the order the bot is woken in:
    // the terminal run event is appended by the ingest first, and the answer and
    // the run's own outcome land after it. Delivering here while the run row
    // still says `running` is the whole point of the claim — read eagerly, the
    // chat says "the turn ended running without an answer" about a turn that
    // answered.
    const spoken = "here is what I did";
    const beforeAnswer = calls.length;
    const closingOut = Effect.sleep(ANSWER_WRITE_DELAY).pipe(
      Effect.andThen(
        messages.append({
          body: spoken,
          role: "manager",
          runId: turn.id,
          threadId: opened.id,
          workspaceId,
        })
      ),
      // After the message, because that is the contract `closeChatTurn` keeps:
      // a run that reads as ended has its answer beside it already.
      Effect.andThen(
        closeTurn({ runId: turn.id, workspaceId }).pipe(
          Effect.provide(turnStoreLayer)
        )
      )
    );
    yield* Effect.all(
      [
        closingOut,
        deliverAnswer({ notices, run: { id: turn.id, workspaceId } }),
      ],
      { concurrency: "unbounded" }
    );
    const delivered = calls.slice(beforeAnswer);
    yield* check({
      detail: `the bot said ${JSON.stringify(delivered.find((call) => call.method === "sendMessage")?.payload.text)}`,
      ok: delivered.some(
        (call) =>
          call.method === "sendMessage" &&
          String(call.payload.text ?? "").includes(spoken)
      ),
      step: "the finished turn's own row is what the conversation is answered with",
    });
    yield* check({
      detail: `${delivered.filter((call) => String(call.payload.text ?? "").includes("without an answer")).length} answerless lines sent`,
      ok: delivered.every(
        (call) => !String(call.payload.text ?? "").includes("without an answer")
      ),
      step: "a turn still closing out is waited for, not called answerless",
    });
    yield* check({
      detail: `${delivered.filter((call) => call.method === "deleteMessage").length} queued lines taken down`,
      ok: delivered.some((call) => call.method === "deleteMessage"),
      step: "the queued line comes down with the answer that overtook it",
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

    yield* restartClaims({ calls, workspaceId });
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
    `${SERVICE}: no telegram token, no telegram call, no gateway, no container — data root ${CHECK_ROOT}`
  );
  yield* pureClaims;

  const booted = yield* bootstrap;
  // A fresh chat per invocation: two runs of this check must not read each
  // other's conversation, and there is no delete on a thread to clean up with.
  const chatId = -1 * (Date.now() % CHAT_ID_RANGE);

  const boardCalls: BoardCall[] = [];
  yield* Effect.gen(function* () {
    yield* withVoiceFileFetch;
    yield* wiredClaims({
      boardCalls,
      chatId,
      wiring: booted.wiring,
      workspaceId: booted.workspaceId,
    }).pipe(
      Effect.provide(
        appLayer(booted.wiring, {
          board: stubBoardLayer(boardCalls),
          transcribe: stubTranscribeLayer,
        })
      )
    );
  }).pipe(Effect.scoped);

  yield* Effect.logInfo(
    `every claim held; read the updates back with EVENT_LOG_DIR=${CHECK_EVENT_DIR} bun run logs`
  );
});

BunRuntime.runMain(botCheck);
