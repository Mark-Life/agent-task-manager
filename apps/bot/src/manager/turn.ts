/**
 * One inbound message becomes one container turn.
 *
 * This is the manager's whole runtime. There is no loop, no run row and no
 * task: a message arrives, a container is created with the conversation's own
 * directories, the provider answers into a file the host is tailing, the answer
 * is rendered into the chat as it lands, and the container is removed. What
 * survives is a `chat_message` row and, where the provider named one, the
 * session the next turn resumes.
 *
 * **The container is the same container a worker run gets, minus a task.** Same
 * image, same entrypoint bundle, same spec file, same event ledger, same three
 * nested caps. What differs is the mount set — no repo, no task artifacts, an
 * empty workspace — and the tools, which are the board's HTTP contract behind
 * an MCP server rather than a checkout. Keeping the mechanism identical is what
 * makes a manager turn debuggable with everything already written for a run.
 *
 * **The agent home is the thread's, and it is not torn down.** A worker run's
 * home is scoped and removed with the run, because a run is over and its
 * credential copy should not outlive it. A conversation is not over: the vendor
 * keeps its transcript inside that directory, so removing it between turns
 * would make every turn a first turn and `resumeSessionId` would name a session
 * with nothing behind it. The credential is re-seeded each turn, so it is as
 * fresh as the host's; what it costs is a copy on disk for as long as the
 * conversation lives, which is the price of a conversation that remembers.
 *
 * **Three caps, each below the one outside it**, exactly as a run's are: the
 * turn's own deadline, the container's kill below it, and the entrypoint's
 * `Harness.TimedOut` below that — the informative ending, which still writes
 * its events and its last word.
 *
 * **A turn that fails says so.** Every ending produces something the person can
 * read and something the ledger can count. There is no path where a message is
 * swallowed: a failed turn replies with the sanitized class of what went wrong,
 * writes no manager message (so the next prompt still shows the question that
 * went unanswered), and reports an outcome its caller puts on the wide event.
 */

import process from "node:process";
import { ChatMessageRepo, ChatThreadRepo } from "@workspace/db";
import type {
  ChatMessage,
  ChatMessageId,
  ChatThread,
  TelegramChatId,
} from "@workspace/domain";
import { newRunId, TelegramMessageId, traceparentOf } from "@workspace/domain";
import {
  AgentEventRecord,
  agentHomeOf,
  CONTAINER_ENTRYPOINT_COMMAND,
  containerEntrypointArgs,
  containerRunLayout,
  entrypointBundlePathOf,
  mcpServersPathOf,
  prepareAgentHome,
  type RunLayout,
  TurnResult,
  TurnSpec,
  turnResultPathOf,
  turnSpecPathOf,
} from "@workspace/harness";
import {
  managerMcpBundlePathOf,
  managerMcpRunCopyPathOf,
} from "@workspace/manager-tools";
import {
  CONTAINER_WORKSPACE_DIR,
  DEFAULT_SANDBOX_IMAGE,
  defaultHardening,
  eventLogDirOf,
  globalArtifactsDirOf,
  managerMountsFor,
  type OutputChunk,
  Sandbox,
  type SandboxSpec,
} from "@workspace/sandbox";
import { clipError } from "@workspace/telemetry";
import { makeTokenSigner } from "@workspace/token";
import {
  Context,
  Effect,
  Layer,
  Option,
  Ref,
  Schedule,
  Schema,
  Semaphore,
} from "effect";
import { FileSystem } from "effect/FileSystem";
import { BotService } from "../telegram/bot-service";
import { makeChatRenderer, type StreamResult } from "../telegram/stream";
import { threadRunDirOf, threadRunLayout, threadWorkspaceDirOf } from "./paths";
import { buildManagerPrompt, type PromptMessage } from "./prompt";
import { mintManagerToken, withMcpServersFile } from "./token";

/** How often the mounted event file is read while the container is running. */
const TAIL_POLL_MS = 250;

/**
 * How much of a cap the cap inside it gives up, at most, and the fraction used
 * instead when the whole cap is smaller than that. The same ladder a run's
 * container is given, for the same reason: setting two caps equal means the
 * kill always wins and the informative ending is never the one recorded.
 */
const CAP_HEADROOM_MS = 30_000;
const CAP_HEADROOM_DIVISOR = 10;

/** The cap for the layer inside one that is already set. */
export const innerCapMs = (capMs: number) =>
  capMs - Math.min(CAP_HEADROOM_MS, Math.ceil(capMs / CAP_HEADROOM_DIVISOR));

/**
 * How a manager turn ended, in the vocabulary the `atm.chat` row speaks.
 * `interrupted` is not here: a turn stopped by `/stop` never returns a value,
 * and its row is written from the fiber's exit by the caller's event wrapper.
 */
export const MANAGER_TURN_OUTCOMES = ["done", "errored", "timeout"] as const;

/** The ending of one turn, as its caller reports it. */
export type ManagerTurnOutcome = (typeof MANAGER_TURN_OUTCOMES)[number];

/**
 * What the manager needs to run a turn. A `Pick` of the app's resolved
 * environment rather than a shape of its own, so a renamed variable is a
 * compile error here instead of a default nobody chose.
 */
export interface ManagerTurnConfig {
  readonly botDraftIntervalMs: number;
  readonly botSplitAt: number;
  readonly dataRoot: string;
  /** The gateway as the **container** sees it, which is rarely `localhost`. */
  readonly managerGatewayUrl: string;
  readonly managerHistoryMessages: number;
  /** `None` leaves the provider on its own default. */
  readonly managerModel: Option.Option<string>;
  readonly managerTokenTtlMs: number;
  readonly managerTurnTimeoutMs: number;
}

/** One message, and the conversation it landed in. */
export interface ManagerTurnInput {
  readonly chatId: TelegramChatId;
  /** Drafts are private-chat only; a group degrades to plain messages. */
  readonly isPrivateChat: boolean;
  readonly message: PromptMessage;
  /**
   * The row the caller already wrote for this message, so the prompt does not
   * show it twice — once as history and once as the question.
   */
  readonly messageId: ChatMessageId | null;
  /** The inbound message the answer replies to, or null. */
  readonly replyToMessageId?: number | null;
  readonly thread: ChatThread;
}

/**
 * What one turn produced. Economics are null unless the turn really reported
 * them: a fabricated zero is a number someone later averages.
 */
export interface ManagerTurnResult {
  readonly containerExitCode: number | null;
  readonly costUsd: number | null;
  readonly errorClass: string | null;
  readonly errorMessage: string | null;
  readonly outcome: ManagerTurnOutcome;
  /** What the next turn resumes, already written to the thread. */
  readonly providerSessionId: string | null;
  readonly replyChars: number | null;
  readonly toolCalls: number | null;
  readonly toolErrors: number | null;
  readonly totalTokens: number | null;
  readonly turns: number | null;
}

/**
 * The manager's board tools are not built on this host.
 *
 * Its own failure rather than a warning, because the alternative is an agent
 * with no way to reach the board that answers anyway — and what it answers is a
 * confident account of tasks it did not file.
 */
export class ManagerBundleMissing extends Schema.TaggedErrorClass<ManagerBundleMissing>()(
  "Manager.BundleMissing",
  { path: Schema.String }
) {
  override get message() {
    return `the manager's board tools are not built: ${this.path}`;
  }
}

const encodeSpec = Schema.encodeEffect(TurnSpec);
const decodeRecord = Schema.decodeUnknownOption(AgentEventRecord);
const decodeResult = Schema.decodeUnknownOption(TurnResult);

/**
 * The lines of a growing JSONL file that are certainly whole. A poll can catch
 * the writer between its bytes and its newline, so a trailing fragment waits
 * for the next pass rather than being read as a truncated event.
 */
const settledLines = (content: string) => {
  const parts = content.split("\n");
  const whole = content.endsWith("\n") ? parts : parts.slice(0, -1);
  return whole.filter((line) => line.trim().length > 0);
};

/** One line of the event file, or null where this build cannot read it. */
const parseRecord = (line: string) => {
  try {
    return Option.getOrNull(decodeRecord(JSON.parse(line)));
  } catch {
    return null;
  }
};

/**
 * The user the container runs as, `uid:gid`. The host's own: a bind mount
 * carries host ownership straight through, so a container that is not whoever
 * owns the data root boots fine and cannot write its own agent home.
 */
const hostUser = () =>
  process.getuid === undefined || process.getgid === undefined
    ? defaultHardening.user
    : `${process.getuid()}:${process.getgid()}`;

/** The span this turn belongs to, as a `traceparent` the container joins. */
const currentTraceparent = Effect.currentSpan.pipe(
  Effect.map((span) =>
    traceparentOf({
      sampled: span.sampled,
      spanId: span.spanId,
      traceId: span.traceId,
    })
  ),
  Effect.orElseSucceed(() => null)
);

/** Telegram ids are integers on the wire; the domain brands them. */
const telegramMessageIdOf = (value: number | null) =>
  value === null ? null : TelegramMessageId.make(value);

/** The container's last word, or null where it left none. */
const readTurnResult = Effect.fnUntraced(function* (path: string) {
  const fs = yield* FileSystem;
  const raw = yield* fs
    .readFileString(path)
    .pipe(Effect.orElseSucceed(() => ""));
  try {
    return Option.getOrNull(decodeResult(JSON.parse(raw)));
  } catch {
    return null;
  }
});

/**
 * What the turn tells the person when it could not answer.
 *
 * The class and nothing else. A stack trace or a raw daemon message in a chat
 * window is noise the reader cannot act on, and `clipError` is also what
 * redacts a bot token out of an error carrying a download url.
 */
/**
 * The ending a class of failure is. `TimedOut` is kept apart from the rest
 * because a turn that outlived its cap and a turn that crashed are different
 * questions, and folding them together makes a slow provider look broken.
 */
const outcomeOf = (errorClass: string | null): ManagerTurnOutcome => {
  if (errorClass === null) {
    return "done";
  }
  return errorClass === "TimedOut" ? "timeout" : "errored";
};

const failureReply = (input: {
  readonly errorClass: string;
  readonly errorMessage: string | null;
}) =>
  input.errorMessage === null
    ? `That turn failed: ${input.errorClass}.`
    : `That turn failed: ${input.errorClass} — ${input.errorMessage}`;

const make = Effect.fnUntraced(function* (config: ManagerTurnConfig) {
  const bot = yield* BotService;
  const messages = yield* ChatMessageRepo;
  const sandbox = yield* Sandbox;
  const signer = yield* makeTokenSigner;
  const threads = yield* ChatThreadRepo;

  const { dataRoot } = config;
  const bundlePath = managerMcpBundlePathOf(dataRoot);
  const containerCapMs = innerCapMs(config.managerTurnTimeoutMs);

  /**
   * The conversation's directories, made if they are not there. Every turn, not
   * only the first: a directory removed underneath a live thread is a container
   * that refuses to start, and creating one that exists costs a syscall.
   */
  const ensureDirectories = Effect.fnUntraced(function* (input: {
    readonly runDir: string;
    readonly workspaceDir: string;
  }) {
    const fs = yield* FileSystem;
    for (const path of [
      input.runDir,
      eventLogDirOf(input.runDir),
      input.workspaceDir,
      globalArtifactsDirOf(dataRoot),
    ]) {
      yield* fs.makeDirectory(path, { recursive: true });
    }
  });

  /**
   * The run directory, cleared of the last turn's answer.
   *
   * The directory is per thread, so both files are already there from last time
   * — an event file that is appended to would replay the previous turn into the
   * chat, and a result file that is never overwritten would report the previous
   * turn's ending as this one's.
   */
  const resetRunDirectory = Effect.fnUntraced(function* (layout: RunLayout) {
    const fs = yield* FileSystem;
    yield* fs.writeFileString(layout.eventLogPath, "");
    yield* fs.remove(turnResultPathOf(layout), { force: true });
  });

  /** The board tools, copied onto the mount the container reads them from. */
  const copyBundle = Effect.fnUntraced(function* (runDir: string) {
    const fs = yield* FileSystem;
    const present = yield* fs
      .exists(bundlePath)
      .pipe(Effect.orElseSucceed(() => false));
    if (!present) {
      return yield* Effect.fail(new ManagerBundleMissing({ path: bundlePath }));
    }
    yield* fs
      .copyFile(bundlePath, managerMcpRunCopyPathOf(runDir))
      .pipe(
        Effect.mapError(() => new ManagerBundleMissing({ path: bundlePath }))
      );
  });

  /** The container one turn runs in, over the conversation's own directories. */
  const sandboxSpecFor = (input: {
    readonly identity: SandboxSpec["identity"];
    readonly runDir: string;
    readonly workspaceDir: string;
  }): SandboxSpec => ({
    args: [...containerEntrypointArgs()],
    command: CONTAINER_ENTRYPOINT_COMMAND,
    // Nothing of the host's: the credential the manager needs is in the agent
    // home on the run mount, and the board token is in the servers file beside
    // it. An environment is printed by `docker inspect`.
    env: {},
    hardening: { ...defaultHardening, user: hostUser() },
    identity: input.identity,
    image: DEFAULT_SANDBOX_IMAGE,
    mounts: managerMountsFor(
      {
        globalArtifactsDir: globalArtifactsDirOf(dataRoot),
        runDir: input.runDir,
        workspaceDir: input.workspaceDir,
      },
      { entrypointPath: entrypointBundlePathOf(dataRoot) }
    ),
    timeoutMs: containerCapMs,
    workingDir: CONTAINER_WORKSPACE_DIR,
  });

  /** The thread's recent rows, minus the message this turn is answering. */
  const historyFor = Effect.fnUntraced(function* (input: ManagerTurnInput) {
    const rows = yield* messages.recent({
      limit: config.managerHistoryMessages + 1,
      threadId: input.thread.id,
      workspaceId: input.thread.workspaceId,
    });
    return rows.filter(
      (row: ChatMessage) =>
        input.messageId === null || row.id !== input.messageId
    );
  });

  /**
   * Records what the provider named itself, on every ending that produced one.
   * A crashed turn that got as far as a session is still resumable, so this is
   * not on the happy path only. Best-effort: a thread that failed to remember
   * its session costs the next turn a cold start, not the answer just given.
   */
  const rememberSession = Effect.fnUntraced(function* (input: {
    readonly providerSessionId: string | null;
    readonly thread: ChatThread;
  }) {
    if (
      input.providerSessionId === null ||
      input.providerSessionId === input.thread.providerSessionId
    ) {
      return;
    }
    yield* threads
      .setProviderSession({
        id: input.thread.id,
        providerSessionId: input.providerSessionId,
        workspaceId: input.thread.workspaceId,
      })
      .pipe(
        Effect.tapError((cause) =>
          Effect.logWarning("provider session not recorded", { cause })
        ),
        Effect.ignore
      );
  });

  /** The manager's own words, appended to the conversation it said them in. */
  const rememberAnswer = Effect.fnUntraced(function* (input: {
    readonly rendered: StreamResult;
    readonly thread: ChatThread;
    readonly telegramChatId: TelegramChatId;
  }) {
    if (input.rendered.text.length === 0) {
      return;
    }
    yield* messages
      .append({
        body: input.rendered.text,
        providerSessionId: input.rendered.providerSessionId,
        role: "manager",
        telegramChatId: input.telegramChatId,
        telegramMessageId: telegramMessageIdOf(input.rendered.lastMessageId),
        threadId: input.thread.id,
        workspaceId: input.thread.workspaceId,
      })
      .pipe(
        Effect.tapError((cause) =>
          Effect.logWarning("manager message not stored", { cause })
        ),
        Effect.ignore
      );
  });

  /**
   * The container, and the answer coming back out of it.
   *
   * Scoped: the renderer's typing indicator and the tail fiber both die with
   * this scope, so a turn that is interrupted stops claiming to be typing and
   * stops reading a file nobody is writing.
   */
  const streamTurn = Effect.fnUntraced(function* (options: {
    readonly identity: SandboxSpec["identity"];
    readonly input: ManagerTurnInput;
    readonly layout: RunLayout;
    readonly runDir: string;
    readonly workspaceDir: string;
  }) {
    const { identity, input, layout } = options;
    const fs = yield* FileSystem;
    const renderer = yield* makeChatRenderer({
      api: bot.api,
      chatId: input.chatId,
      draftIntervalMs: config.botDraftIntervalMs,
      isPrivateChat: input.isPrivateChat,
      replyToMessageId: input.replyToMessageId ?? null,
      splitAt: config.botSplitAt,
    });

    const consumed = yield* Ref.make(0);
    // One reader at a time: the poll and the final read after teardown would
    // otherwise render the same line twice.
    const reader = yield* Semaphore.make(1);

    /** Every event the file has gained since the last pass, in file order. */
    const drain = reader.withPermits(1)(
      Effect.gen(function* () {
        const content = yield* fs
          .readFileString(layout.eventLogPath)
          .pipe(Effect.orElseSucceed(() => ""));
        const lines = settledLines(content);
        const from = yield* Ref.get(consumed);
        for (let at = from; at < lines.length; at += 1) {
          const record = parseRecord(lines[at] ?? "");
          if (record !== null) {
            yield* renderer.push(record.event);
          }
          // Advanced per line, so an interrupt mid-pass costs at most the line
          // it landed on rather than replaying the batch into the chat.
          yield* Ref.set(consumed, at + 1);
        }
      })
    );

    /** The entrypoint's own log, worth having when a turn misbehaves. */
    const onOutput = (chunk: OutputChunk) => {
      const text = chunk.text.trimEnd();
      return text.length === 0
        ? Effect.void
        : Effect.logDebug(text).pipe(
            Effect.annotateLogs({ stream: chunk.stream })
          );
    };

    const ran = yield* Effect.scoped(
      Effect.gen(function* () {
        yield* Effect.forkScoped(
          drain.pipe(Effect.repeat(Schedule.spaced(TAIL_POLL_MS)))
        );
        return yield* sandbox.run({
          onOutput,
          spec: sandboxSpecFor({
            identity,
            runDir: options.runDir,
            workspaceDir: options.workspaceDir,
          }),
        });
      })
    ).pipe(
      // The last read, on every exit path — including the one where the
      // container was torn down mid-sentence and its final lines are all there
      // is.
      Effect.onExit(() => Effect.ignoreCause(drain))
    );

    return {
      exitCode: ran.exitCode,
      rendered: yield* renderer.finish(),
      result: yield* readTurnResult(turnResultPathOf(layout)),
    };
  });

  /**
   * What the turn leaves behind once the container is gone: the session for the
   * next turn, and either the answer or the reason there is none.
   */
  const closeOut = Effect.fnUntraced(function* (options: {
    readonly ending: Effect.Success<ReturnType<typeof streamTurn>>;
    readonly input: ManagerTurnInput;
  }) {
    const { ending, input } = options;
    const { rendered, result } = ending;
    const { thread } = input;
    const providerSessionId =
      rendered.providerSessionId ?? result?.providerSessionId ?? null;
    const errorClass = rendered.errorClass ?? result?.errorClass ?? null;
    const errorMessage = rendered.errorMessage ?? result?.errorMessage ?? null;
    const complete = errorClass === null;

    yield* rememberSession({ providerSessionId, thread });
    if (complete) {
      yield* rememberAnswer({
        rendered,
        telegramChatId: input.chatId,
        thread,
      });
    } else {
      yield* bot
        .send({
          chatId: input.chatId,
          text: failureReply({ errorClass, errorMessage }),
        })
        .pipe(Effect.ignore);
    }

    return {
      containerExitCode: ending.exitCode,
      costUsd: complete ? rendered.costUsd : null,
      errorClass,
      errorMessage,
      outcome: outcomeOf(errorClass),
      providerSessionId,
      replyChars: complete ? rendered.text.length : null,
      toolCalls: rendered.toolCalls,
      toolErrors: rendered.toolErrors,
      totalTokens: complete ? rendered.totalTokens : null,
      turns: complete ? rendered.turns : null,
    } satisfies ManagerTurnResult;
  });

  /**
   * One turn: prepare, run, render, remember.
   *
   * Never fails. Every way this can go wrong is an ending the person can read
   * and the ledger can count, because a chat that goes quiet is indistinguishable
   * from a bot that died.
   */
  const run = Effect.fn("Manager.turn")(function* (input: ManagerTurnInput) {
    const { thread } = input;
    yield* Effect.annotateCurrentSpan({
      provider: thread.provider,
      resumed: thread.providerSessionId !== null,
      threadId: thread.id,
      workspaceId: thread.workspaceId,
    });

    const fs = yield* FileSystem;
    const dirInput = { dataRoot, threadId: thread.id };
    const layout = threadRunLayout(dirInput);
    const runDir = threadRunDirOf(dirInput);
    const workspaceDir = threadWorkspaceDirOf(dirInput);
    const traceparent = yield* currentTraceparent;
    // A fresh id per turn, for the container's name, its docker label and the
    // `atm.turn` row it writes. There is no run row behind it: the id is
    // correlation, and `taskId: null` beside it is what says so.
    const identity = {
      runId: newRunId(),
      sessionId: null,
      taskId: null,
      traceparent,
      workspaceId: thread.workspaceId,
    } satisfies SandboxSpec["identity"];

    /** What a failed turn reports, once, on whichever path it failed. */
    const failed = Effect.fnUntraced(function* (failure: {
      readonly errorClass: string;
      readonly errorMessage: string | null;
      readonly outcome: ManagerTurnOutcome;
    }) {
      yield* bot
        .send({
          chatId: input.chatId,
          text: failureReply(failure),
        })
        .pipe(
          Effect.tapError((cause) =>
            Effect.logWarning("failure reply not delivered", { cause })
          ),
          Effect.ignore
        );
      // Read even here: a container that crashed after the provider named its
      // session left that name behind, and the next turn can still resume.
      const result = yield* readTurnResult(turnResultPathOf(layout));
      yield* rememberSession({
        providerSessionId: result?.providerSessionId ?? null,
        thread,
      });
      return {
        containerExitCode: null,
        costUsd: null,
        errorClass: failure.errorClass,
        errorMessage: failure.errorMessage,
        outcome: failure.outcome,
        providerSessionId: result?.providerSessionId ?? null,
        replyChars: null,
        toolCalls: null,
        toolErrors: null,
        totalTokens: null,
        turns: null,
      } satisfies ManagerTurnResult;
    });

    const turn = Effect.gen(function* () {
      yield* ensureDirectories({ runDir, workspaceDir });
      yield* resetRunDirectory(layout);
      yield* copyBundle(runDir);
      // Re-seeded rather than scoped: the transcript in this directory is what
      // the next turn resumes, and the credential is refreshed by copying it
      // again.
      yield* prepareAgentHome({
        layout,
        provider: thread.provider,
        sourceDir: null,
      });

      const history = yield* historyFor(input);
      const prompt = buildManagerPrompt({
        history,
        historyLimit: config.managerHistoryMessages,
        message: input.message,
      });

      const spec = yield* encodeSpec({
        agentHomeDir: agentHomeOf(containerRunLayout, thread.provider),
        effort: null,
        eventLogPath: containerRunLayout.eventLogPath,
        // The same ids the container is started with, so a container run by
        // hand from this file still joins the conversation it claims to be.
        identity,
        model: Option.getOrNull(config.managerModel),
        prompt,
        provider: thread.provider,
        resumeSessionId: thread.providerSessionId,
        timeoutMs: innerCapMs(containerCapMs),
        workspaceDir: CONTAINER_WORKSPACE_DIR,
      });
      // The prompt travels in this file and nowhere else.
      yield* fs.writeFileString(
        turnSpecPathOf(layout),
        `${JSON.stringify(spec)}\n`
      );

      const token = yield* mintManagerToken({
        signer,
        threadId: thread.id,
        ttlMs: config.managerTokenTtlMs,
        userId: thread.userId,
        workspaceId: thread.workspaceId,
      });

      const ending = yield* withMcpServersFile(
        {
          gatewayUrl: config.managerGatewayUrl,
          path: mcpServersPathOf(layout),
          token,
        },
        Effect.scoped(
          streamTurn({ identity, input, layout, runDir, workspaceDir })
        )
      );
      return yield* closeOut({ ending, input });
    });

    return yield* turn.pipe(
      // Every typed failure below — a missing bundle, an unreachable daemon, a
      // mount source that is not there, a Telegram send that would not go —
      // ends the same way: the person is told, and the row says which class.
      Effect.catch((error) =>
        Effect.gen(function* () {
          yield* Effect.logError("manager turn failed", error);
          return yield* failed({
            errorClass: error._tag,
            errorMessage: clipError(error.message),
            outcome: "errored",
          });
        })
      ),
      // The turn's own deadline, outside the container's kill. A turn that
      // outlived it is an ending, not a crash.
      Effect.timeoutOrElse({
        duration: config.managerTurnTimeoutMs,
        orElse: () =>
          failed({
            errorClass: "TimedOut",
            errorMessage: `the turn outlived ${config.managerTurnTimeoutMs}ms`,
            outcome: "timeout",
          }),
      })
    );
  });

  return { run } as const;
});

/**
 * One message into one container turn.
 *
 * The configuration is a value the composition root passes rather than
 * something read here, so the app's one config module stays the only place an
 * environment variable is read — and so a check script can run a turn against a
 * data root of its own.
 */
export class ManagerTurn extends Context.Service<
  ManagerTurn,
  Effect.Success<ReturnType<typeof make>>
>()("@workspace/bot/ManagerTurn") {
  static readonly layer = (config: ManagerTurnConfig) =>
    Layer.effect(ManagerTurn, make(config));
}
