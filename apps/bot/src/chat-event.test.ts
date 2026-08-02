import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BunFileSystem } from "@effect/platform-bun";
import { Telemetry } from "@workspace/telemetry";
import {
  ConfigProvider,
  Deferred,
  Effect,
  Fiber,
  Layer,
  Logger,
  type LogLevel,
  Metric,
  References,
} from "effect";
import {
  CHAT_EVENT_MARKER,
  type ChatContext,
  ChatEvent,
  type ChatProgress,
  makeChatProgress,
  observeChat,
  withChatEvent,
} from "./chat-event";

const SERVICE = "bot-test";
const COUNTER = "atm_chat_updates_total";
const HISTOGRAM = "atm_chat_turn_duration_ms";

type Row = Record<string, unknown>;

/** Captures the wide event by its marker, and every log line for comparison. */
const captureLogger = (events: Row[], lines: Row[]) =>
  Logger.make((options) => {
    const annotations = options.fiber.getRef(References.CurrentLogAnnotations);
    lines.push({ ...annotations });
    if (annotations.event === CHAT_EVENT_MARKER) {
      events.push({ ...annotations });
    }
  });

interface Capture {
  readonly events: Row[];
  readonly lines: Row[];
}

const telemetryLayer = (
  logDirectory: string,
  sink: Capture,
  level: LogLevel.LogLevel
) =>
  Layer.mergeAll(
    Telemetry.layer({ serviceName: SERVICE }),
    Logger.layer([captureLogger(sink.events, sink.lines)]),
    Layer.succeed(References.MinimumLogLevel, level)
  ).pipe(
    Layer.provide(
      Layer.mergeAll(
        BunFileSystem.layer,
        ConfigProvider.layer(
          ConfigProvider.fromUnknown({
            EVENT_LOG_DIR: logDirectory,
            GIT_SHA: "abc1234",
            SERVICE_VERSION: "1.2.3",
          })
        )
      )
    )
  );

let directory: string;
let capture: Capture;

beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), "chat-event-"));
  capture = { events: [], lines: [] };
});

afterEach(() => {
  rmSync(directory, { force: true, recursive: true });
});

const run = <A, E>(
  program: Effect.Effect<A, E, Telemetry>,
  level: LogLevel.LogLevel = "Info"
) =>
  Effect.runPromise(
    program.pipe(
      Effect.exit,
      Effect.provide(telemetryLayer(directory, capture, level))
    )
  );

const readRows = (): Row[] => {
  try {
    return readFileSync(join(directory, `${SERVICE}.jsonl`), "utf-8")
      .split("\n")
      .filter((line) => line.trim().length > 0)
      .map((line) => JSON.parse(line) as Row);
  } catch {
    return [];
  }
};

/** The single row a unit of work just wrote. Fails loudly when the count is not one. */
const onlyRow = () => {
  const rows = readRows();
  const [row] = rows;
  if (!row || rows.length !== 1) {
    throw new Error(`expected exactly one row, found ${rows.length}`);
  }
  return row;
};

/** A typed sentence from an allow-listed sender, before anything has happened to it. */
const inbound = (progress: ChatContext["progress"]): ChatContext => ({
  chatId: "-1001234567890",
  progress,
  telegramUserId: "77001",
  updateKind: "text",
  userId: "user_9f2",
  workspaceId: "ws_44",
});

/**
 * One update, handled: the context, the work, and the row it left. `handle`
 * folds what it learned exactly as a real handler does — through
 * {@link observeChat}, from under the middleware rather than beside it.
 */
const handleUpdate = <A, E>(options: {
  readonly context?: (progress: ChatContext["progress"]) => ChatContext;
  readonly handle: Effect.Effect<A, E>;
  readonly level?: LogLevel.LogLevel;
}) =>
  run(
    Effect.gen(function* () {
      const progress = yield* makeChatProgress;
      const context = (options.context ?? inbound)(progress);
      return yield* options.handle.pipe(withChatEvent(context));
    }),
    options.level ?? "Info"
  );

/** What a manager turn that finished folds back into the row. */
const COMPLETED_TURN: Partial<ChatProgress> = {
  containerExitCode: 0,
  costUsd: 0.0134,
  gatewayToolCalls: 3,
  gatewayToolErrors: 0,
  promptChars: 812,
  provider: "claude",
  providerSessionId: "sess_abc",
  queueWaitMs: 12,
  replyChars: 240,
  runId: "run_7",
  taskId: "task_3",
  threadId: "thread_1",
  totalTokens: 4096,
  turns: 2,
};

describe("the atm.chat row", () => {
  test("a handled message leaves exactly one row, carrying what the turn produced", async () => {
    const exit = await handleUpdate({
      handle: observeChat(COMPLETED_TURN),
    });

    expect(exit._tag).toBe("Success");
    const row = onlyRow();
    expect(capture.events).toHaveLength(1);
    expect(row.event).toBe(CHAT_EVENT_MARKER);
    expect(row.phase).toBe("end");
    expect(row.outcome).toBe("done");
    expect(row.updateKind).toBe("text");
    // who it was, on every id the row joins on
    expect(row.chatId).toBe("-1001234567890");
    expect(row.telegramUserId).toBe("77001");
    expect(row.userId).toBe("user_9f2");
    expect(row.workspaceId).toBe("ws_44");
    expect(row.threadId).toBe("thread_1");
    expect(row.taskId).toBe("task_3");
    expect(row.runId).toBe("run_7");
    // a manager turn is not an agent session; the provider's own id is beside it
    expect(row.sessionId).toBeNull();
    expect(row.provider).toBe("claude");
    expect(row.providerSessionId).toBe("sess_abc");
    // the economics a finished turn really produced
    expect(row.costUsd).toBe(0.0134);
    expect(row.totalTokens).toBe(4096);
    expect(row.turns).toBe(2);
    expect(row.queueWaitMs).toBe(12);
    expect(row.gatewayToolCalls).toBe(3);
    expect(row.containerExitCode).toBe(0);
    expect(typeof row.durationMs).toBe("number");
    expect(row.errorClass).toBeNull();
    // content is measured, never carried
    expect(row.promptChars).toBe(812);
    expect(row.replyChars).toBe(240);
    expect(row).not.toHaveProperty("prompt");
    expect(row).not.toHaveProperty("body");
    // nothing about a voice note happened, so neither field invents a 0
    expect(row.transcriptChars).toBeNull();
    expect(row.transcribeMs).toBeNull();
  });

  test("a sender who is not on the allow-list is a row, not a silence", async () => {
    const exit = await handleUpdate({
      context: (progress) => ({
        chatId: "88002",
        progress,
        telegramUserId: "88002",
        updateKind: "text",
        // the allow-list did not know them, so there is nobody to attribute to
        userId: null,
        workspaceId: null,
      }),
      // the middleware replies once and returns: a refusal is an answer
      handle: observeChat({ outcome: "not_allowed", replyChars: 46 }),
    });

    expect(exit._tag).toBe("Success");
    const row = onlyRow();
    expect(row.outcome).toBe("not_allowed");
    expect(row.telegramUserId).toBe("88002");
    expect(row.userId).toBeNull();
    expect(row.workspaceId).toBeNull();
    expect(row.threadId).toBeNull();
    // nothing was read from the update, and nothing was spent on it
    expect(row.promptChars).toBe(0);
    expect(row.costUsd).toBeNull();
    expect(row.totalTokens).toBeNull();
    expect(row.turns).toBeNull();
    expect(row.queueWaitMs).toBeNull();
    expect(row.replyChars).toBeNull();
    // the one number a degraded row still carries, because it was measured
    expect(typeof row.durationMs).toBe("number");
  });

  test("an expired button is rejected, and the update kind is the one it really was", async () => {
    await handleUpdate({
      handle: observeChat({ outcome: "rejected", updateKind: "callback" }),
    });

    const row = onlyRow();
    expect(row.outcome).toBe("rejected");
    // the middleware guessed `text` from the raw update; the handler knew better
    expect(row.updateKind).toBe("callback");
  });

  test("a failed turn leaves one row with null economics and a sanitized class", async () => {
    const exit = await handleUpdate({
      handle: Effect.gen(function* () {
        yield* observeChat({
          ...COMPLETED_TURN,
          // the container died: what it had spent is partial, what it counted is real
          containerExitCode: 137,
          costUsd: 0.004,
          gatewayToolCalls: 2,
          gatewayToolErrors: 1,
        });
        return yield* Effect.fail(
          new Error("manager turn failed: Bearer atm1.secret-token")
        );
      }),
    });

    expect(exit._tag).toBe("Failure");
    const row = onlyRow();
    expect(row.outcome).toBe("errored");
    // a partial cost stored as final is a number someone later averages
    expect(row.costUsd).toBeNull();
    expect(row.totalTokens).toBeNull();
    expect(row.turns).toBeNull();
    expect(row.queueWaitMs).toBeNull();
    expect(row.replyChars).toBeNull();
    // what the bot measured itself stays: this is what makes a failure readable
    expect(row.containerExitCode).toBe(137);
    expect(row.gatewayToolCalls).toBe(2);
    expect(row.gatewayToolErrors).toBe(1);
    expect(row.promptChars).toBe(812);
    expect(typeof row.durationMs).toBe("number");
    // the failure names itself, and its text never carries a credential
    expect(row.errorClass).toBe("Error");
    expect(row.errorMessage).toContain("manager turn failed");
    expect(JSON.stringify(row)).not.toContain("secret-token");
  });

  test("a defect leaves the same single row as a typed failure", async () => {
    await handleUpdate({ handle: Effect.die(new Error("handler exploded")) });

    const row = onlyRow();
    expect(row.outcome).toBe("errored");
    expect(row.errorMessage).toContain("handler exploded");
  });

  test("a turn that ran out of time keeps its own ending, rather than `errored`", async () => {
    await handleUpdate({
      handle: Effect.gen(function* () {
        yield* observeChat({
          errorClass: "Harness.TimedOut",
          outcome: "timeout",
        });
        return yield* Effect.fail("the container passed its cap");
      }),
    });

    const row = onlyRow();
    expect(row.outcome).toBe("timeout");
    expect(row.errorClass).toBe("Harness.TimedOut");
    expect(row.costUsd).toBeNull();
  });

  test("a turn stopped by /stop leaves one row, as an interrupt", async () => {
    await run(
      Effect.gen(function* () {
        const progress = yield* makeChatProgress;
        const started = yield* Deferred.make<void>();
        const fiber = yield* Effect.forkChild(
          Effect.gen(function* () {
            yield* observeChat(COMPLETED_TURN);
            yield* Deferred.succeed(started, undefined);
            return yield* Effect.never;
          }).pipe(withChatEvent(inbound(progress)))
        );
        yield* Deferred.await(started);
        yield* Fiber.interrupt(fiber);
      })
    );

    const row = onlyRow();
    expect(row.outcome).toBe("interrupted");
    expect(row.errorClass).toBe("Interrupted");
    // a deliberate stop is not a crash, and it did not cost what it would have
    expect(row.costUsd).toBeNull();
    expect(row.totalTokens).toBeNull();
    // it did really run three tools before it was stopped
    expect(row.gatewayToolCalls).toBe(3);
  });

  test("a voice note carries its two measurements, and only it does", async () => {
    await handleUpdate({
      handle: observeChat({
        promptChars: 96,
        transcribeMs: 431,
        transcriptChars: 96,
        updateKind: "voice",
      }),
    });

    const row = onlyRow();
    expect(row.updateKind).toBe("voice");
    expect(row.transcriptChars).toBe(96);
    expect(row.transcribeMs).toBe(431);
  });

  test("an outbound notification is a row of the same shape", async () => {
    await handleUpdate({
      context: (progress) => ({
        chatId: "-1001234567890",
        progress,
        telegramUserId: "77001",
        updateKind: "notify",
        userId: "user_9f2",
        workspaceId: "ws_44",
      }),
      handle: observeChat({
        notifyKind: "run_failed",
        replyChars: 310,
        taskId: "task_3",
        threadId: "thread_1",
      }),
    });

    const row = onlyRow();
    expect(row.updateKind).toBe("notify");
    expect(row.notifyKind).toBe("run_failed");
    expect(row.outcome).toBe("done");
    expect(row.replyChars).toBe(310);
    expect(row.promptChars).toBe(0);
  });

  test("observeChat outside an update is a no-op, never a failure", async () => {
    const exit = await run(
      Effect.as(observeChat({ promptChars: 10 }), "handled")
    );

    expect(exit._tag).toBe("Success");
    expect(readRows()).toHaveLength(0);
  });

  test("the row survives a Warn floor that silences ordinary log lines", async () => {
    await handleUpdate({
      handle: Effect.logInfo("narration that should be dropped"),
      level: "Warn",
    });

    expect(capture.events).toHaveLength(1);
    // the only line that reached a logger is the wide event itself
    expect(capture.lines).toHaveLength(1);
    expect(readRows()).toHaveLength(1);
  });

  test("a command name is carried, and clipped like any caller-controlled text", () => {
    // the schema is what enforces the clip, so the encoder is what is asserted
    const encoded = ChatEvent.encode({
      chatId: "1",
      commandName: `/stop ${"x".repeat(400)}`,
      containerExitCode: null,
      costUsd: null,
      durationMs: 4,
      errorClass: null,
      errorMessage: null,
      gatewayToolCalls: null,
      gatewayToolErrors: null,
      notifyKind: null,
      outcome: "done",
      phase: "end",
      promptChars: 0,
      provider: null,
      providerSessionId: null,
      queueWaitMs: null,
      replyChars: null,
      runId: null,
      sessionId: null,
      spanId: null,
      taskId: null,
      telegramUserId: "1",
      threadId: null,
      totalTokens: null,
      traceId: null,
      transcribeMs: null,
      transcriptChars: null,
      turns: null,
      updateKind: "command",
      userId: null,
      workspaceId: null,
    });

    expect(String(encoded.commandName)).toHaveLength(240);
  });
});

/** Every series of one metric after the work, with its attribute keys. */
const seriesOf = (id: string) =>
  Effect.runPromise(
    Effect.map(Metric.snapshot, (snapshot) =>
      snapshot.filter((metric) => metric.id === id)
    )
  );

describe("the chat metrics", () => {
  test("atm_chat_updates_total is tagged by kind, outcome and provider only", async () => {
    await handleUpdate({ handle: observeChat(COMPLETED_TURN) });

    const series = await seriesOf(COUNTER);
    expect(series.length).toBeGreaterThan(0);
    for (const metric of series) {
      // pins the tag boundary: an unbounded tag added later fails here
      expect(Object.keys(metric.attributes ?? {}).sort()).toEqual([
        "kind",
        "outcome",
        "provider",
      ]);
    }
    expect(
      series.some(
        (metric) =>
          metric.attributes?.kind === "text" &&
          metric.attributes?.outcome === "done" &&
          metric.attributes?.provider === "claude"
      )
    ).toBe(true);
  });

  test("a refused update is counted from the same ending the row reports", async () => {
    await handleUpdate({
      handle: observeChat({ outcome: "not_allowed" }),
    });

    const series = await seriesOf(COUNTER);
    expect(
      series.some(
        (metric) =>
          metric.attributes?.outcome === "not_allowed" &&
          // nothing supplied a provider, and the absent value is one bucket
          metric.attributes?.provider === "none"
      )
    ).toBe(true);
  });

  test("atm_chat_turn_duration_ms is tagged by kind and provider only", async () => {
    await handleUpdate({ handle: observeChat({ updateKind: "voice" }) });

    const series = await seriesOf(HISTOGRAM);
    expect(series.length).toBeGreaterThan(0);
    for (const metric of series) {
      expect(Object.keys(metric.attributes ?? {}).sort()).toEqual([
        "kind",
        "provider",
      ]);
    }
  });
});
