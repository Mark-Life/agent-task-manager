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
  References,
  Schema,
} from "effect";
import { ProviderCrashed, TimedOut } from "./errors";
import { type AgentEvent, costUsdOf } from "./events";
import {
  countTurnEvent,
  emptyTurnCounters,
  makeTurnCounters,
  observeTurnEvent,
  readTurnIdentity,
  TURN_ENV_VARS,
  TURN_EVENT_MARKER,
  type TurnContext,
  TurnEvent,
  withTurnEvent,
} from "./turn-event";

const SERVICE = "harness-test";

/**
 * What the log annotation sinks receive. Open by nature: a logger is handed
 * whatever annotations the fiber carries, so this is `CurrentLogAnnotations`'
 * own type rather than a shape anything here declares.
 */
type Annotations = Record<string, unknown>;

/**
 * One `atm.turn` row, decoded through the schema the roll-up reads it with.
 *
 * `defineEvent` builds `encode` and `rowSchema` from the same fields object, so
 * a renamed field or a changed encoded type moves both at once and is a compile
 * error — the decode adds nothing there. What it does cover is the other half
 * of a row, the part `telemetry.ts` spells by hand and `rowSchema` declares
 * separately: `ts`, the `event` tag and the environment stamp. Those two can
 * disagree, and `turn-rollup.ts` drops a row it cannot decode, so a
 * disagreement costs every run its economics with the suite still green.
 *
 * What no test in one process can reach is cross-build skew: the container runs
 * a prebuilt entrypoint bundle while the host decodes with its own compiled
 * `rowSchema`, so a required field added on the host makes every row from a
 * container on the old image undecodable. That gap is still open.
 */
type Row = typeof TurnEvent.rowSchema.Type;

const decodeRow = Schema.decodeUnknownSync(TurnEvent.rowSchema);

/** The environment the orchestrator sets on the container, plus the ledger's own. */
const ENVIRONMENT = {
  [TURN_ENV_VARS.runId]: "run-1",
  [TURN_ENV_VARS.sessionId]: "sess-1",
  [TURN_ENV_VARS.taskId]: "task-1",
  [TURN_ENV_VARS.workspaceId]: "ws-1",
  GIT_SHA: "abc1234",
  SERVICE_VERSION: "1.2.3",
};

/** Captures the wide event by its marker, and every log line for comparison. */
const captureLogger = (events: Annotations[], lines: Annotations[]) =>
  Logger.make((options) => {
    const annotations = options.fiber.getRef(References.CurrentLogAnnotations);
    lines.push({ ...annotations });
    if (annotations.event === TURN_EVENT_MARKER) {
      events.push({ ...annotations });
    }
  });

interface Capture {
  readonly events: Annotations[];
  readonly lines: Annotations[];
}

const testLayer = (
  logDirectory: string,
  sink: Capture,
  level: LogLevel.LogLevel
) => {
  const configLayer = ConfigProvider.layer(
    ConfigProvider.fromUnknown({ ...ENVIRONMENT, EVENT_LOG_DIR: logDirectory })
  );
  return Layer.mergeAll(
    Telemetry.layer({ serviceName: SERVICE }).pipe(
      Layer.provide(Layer.mergeAll(BunFileSystem.layer, configLayer))
    ),
    Logger.layer([captureLogger(sink.events, sink.lines)]),
    Layer.succeed(References.MinimumLogLevel, level),
    configLayer
  );
};

let directory: string;
let capture: Capture;

beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), "harness-turn-"));
  capture = { events: [], lines: [] };
});

afterEach(() => {
  rmSync(directory, { force: true, recursive: true });
});

const ledgerPath = () => join(directory, `${SERVICE}.jsonl`);

/**
 * The ledger as bytes, which is what every "this never reached a row" assertion
 * has to be made against. A decoded row is no witness for a leak: most text
 * fields are `SanitizedText`, which runs `clipError` on the way in as well as
 * out, so the reader would be redacting the very value it then swears is clean.
 */
const ledgerText = () => readFileSync(ledgerPath(), "utf-8");

/** One ledger line, or null where the line is not JSON at all. */
const jsonOf = (line: string): unknown => {
  try {
    return JSON.parse(line);
  } catch {
    return null;
  }
};

/**
 * Whether a parsed line is a turn row, read off the parsed `event` field. A
 * substring test over the line would also match the marker inside a field
 * value — an error message quoting a command, a path — and hand a foreign row
 * to the decoder, failing the test for the wrong reason.
 */
const isTurnRow = (value: unknown) =>
  typeof value === "object" &&
  value !== null &&
  "event" in value &&
  value.event === TURN_EVENT_MARKER;

const readRows = (): readonly Row[] =>
  ledgerText()
    .split("\n")
    .map(jsonOf)
    .filter(isTurnRow)
    .map((row) => decodeRow(row));

/** The single row a turn just wrote. Fails loudly when the count is not one. */
const onlyRow = () => {
  const rows = readRows();
  const [row] = rows;
  if (!row || rows.length !== 1) {
    throw new Error(`expected exactly one row, found ${rows.length}`);
  }
  return row;
};

const SESSION_INIT: AgentEvent = {
  kind: "session_init",
  model: "claude-sonnet-4-6",
  provider: "claude",
  providerSessionId: "provider-session-1",
};

const REASONING: AgentEvent = {
  chars: 320,
  durationMs: 900,
  kind: "reasoning",
};

const TOOL_CALL: AgentEvent = {
  callId: "call-1",
  inputChars: 40,
  kind: "tool_call",
  summary: "read src/index.ts",
  toolName: "Read",
};

const TOOL_FAILED: AgentEvent = {
  callId: "call-1",
  kind: "tool_result",
  ok: false,
  outputChars: 22,
  summary: "no such file",
};

const USAGE_WARNING: AgentEvent = {
  costUsd: costUsdOf(0.004),
  inputTokens: 100,
  kind: "usage",
  outputTokens: 50,
  rateLimitPct: 84.5,
  rateLimitResetsAtMs: 1_700_000_000_000,
  rateLimitStatus: "allowed_warning",
  rateLimitType: "5h",
  turns: 1,
};

const USAGE_CALM: AgentEvent = {
  costUsd: costUsdOf(0.008),
  inputTokens: 140,
  kind: "usage",
  outputTokens: 70,
  rateLimitPct: 12,
  rateLimitResetsAtMs: null,
  rateLimitStatus: "allowed",
  rateLimitType: "5h",
  turns: 2,
};

const SUBAGENT: AgentEvent = {
  description: "review the diff",
  kind: "subagent_started",
  subagentId: "sub-1",
};

const RESULT: AgentEvent = {
  costUsd: costUsdOf(0.01),
  durationMs: 4200,
  errorClass: null,
  errorMessage: null,
  kind: "result",
  outcome: "done",
  providerSessionId: "provider-session-1",
  text: "all done",
  totalTokens: 360,
  turns: 2,
};

const STREAMED: readonly AgentEvent[] = [
  SESSION_INIT,
  REASONING,
  TOOL_CALL,
  TOOL_FAILED,
  USAGE_WARNING,
  SUBAGENT,
  USAGE_CALM,
];

const context = (
  counters: TurnContext["counters"],
  identity: TurnContext["identity"]
): TurnContext => ({
  agentHomeSet: true,
  counters,
  effort: "high",
  identity,
  model: "sonnet",
  promptChars: 1280,
  provider: "claude",
  resumed: false,
});

/**
 * One provider invocation: the events it streamed, then whatever it did to end.
 * The shape a real provider has — fold every event as it is offered, and let the
 * combinator read the tally on the way out.
 */
const turn = <A>(
  events: readonly AgentEvent[],
  ending: Effect.Effect<A, TimedOut | ProviderCrashed>
) =>
  Effect.gen(function* () {
    const counters = yield* makeTurnCounters;
    const identity = yield* readTurnIdentity();
    const work = Effect.gen(function* () {
      for (const event of events) {
        yield* observeTurnEvent(counters, event);
      }
      return yield* ending;
    });
    return yield* work.pipe(withTurnEvent(context(counters, identity)));
  });

const run = <A, E>(
  program: Effect.Effect<A, E, Telemetry>,
  level: LogLevel.LogLevel = "Info"
) =>
  Effect.runPromise(
    program.pipe(
      Effect.exit,
      Effect.provide(testLayer(directory, capture, level))
    )
  );

describe("countTurnEvent", () => {
  const tally = (events: readonly AgentEvent[]) =>
    events.reduce(countTurnEvent, emptyTurnCounters);

  test("counts what the turn did, from the events themselves", () => {
    const counters = tally([...STREAMED, RESULT]);

    expect(counters.eventsSeen).toBe(8);
    expect(counters.toolCalls).toBe(1);
    expect(counters.toolErrors).toBe(1);
    expect(counters.subagents).toBe(1);
    expect(counters.reasoningChars).toBe(320);
    expect(counters.outcome).toBe("done");
    expect(counters.model).toBe("claude-sonnet-4-6");
    expect(counters.providerSessionId).toBe("provider-session-1");
  });

  test("keeps the worst rate-limit reading and the highest utilization", () => {
    const counters = tally([USAGE_WARNING, USAGE_CALM]);

    // the window nearly closed; a later calm reading does not undo that
    expect(counters.rateLimitStatus).toBe("allowed_warning");
    expect(counters.rateLimitPeakPct).toBe(84.5);
  });

  test("a turn that streamed nothing terminal has no outcome of its own", () => {
    expect(tally(STREAMED).outcome).toBeNull();
  });
});

describe("readTurnIdentity", () => {
  const withEnvironment = <A>(
    program: Effect.Effect<A>,
    environment: Record<string, string>
  ) =>
    Effect.runPromise(
      program.pipe(
        Effect.provide(
          ConfigProvider.layer(ConfigProvider.fromUnknown(environment))
        )
      )
    );

  test("reads the ids the orchestrator passed into the container", async () => {
    const identity = await withEnvironment(readTurnIdentity(), ENVIRONMENT);

    expect(identity).toEqual({
      runId: "run-1",
      sessionId: "sess-1",
      taskId: "task-1",
      workspaceId: "ws-1",
    });
  });

  test("what the caller already holds wins over the environment", async () => {
    const identity = await withEnvironment(
      readTurnIdentity({ runId: "caller-run" }),
      ENVIRONMENT
    );

    expect(identity.runId).toBe("caller-run");
    expect(identity.taskId).toBe("task-1");
  });

  test("an unset or blank variable is no id, never an empty string", async () => {
    const identity = await withEnvironment(readTurnIdentity(), {
      [TURN_ENV_VARS.runId]: "   ",
    });

    expect(identity.runId).toBeNull();
    expect(identity.taskId).toBeNull();
  });
});

describe("withTurnEvent", () => {
  test("a finished turn leaves exactly one atm.turn row", async () => {
    await run(turn([...STREAMED, RESULT], Effect.void));

    expect(capture.events).toHaveLength(1);
    const row = onlyRow();
    expect(row.event).toBe(TURN_EVENT_MARKER);
    expect(row.phase).toBe("end");
    expect(row.outcome).toBe("done");
    // identity comes from the container's environment, so the row joins the run
    expect(row.runId).toBe("run-1");
    expect(row.sessionId).toBe("sess-1");
    expect(row.taskId).toBe("task-1");
    expect(row.workspaceId).toBe("ws-1");
    // what the provider chose beats what was asked for
    expect(row.provider).toBe("claude");
    expect(row.model).toBe("claude-sonnet-4-6");
    expect(row.providerSessionId).toBe("provider-session-1");
    expect(row.promptChars).toBe(1280);
    expect(row.resumed).toBe(false);
    expect(row.agentHomeSet).toBe(true);
    expect(row.toolCalls).toBe(1);
    expect(row.toolErrors).toBe(1);
    expect(row.subagents).toBe(1);
    expect(row.reasoningChars).toBe(320);
    expect(row.costUsd).toBe(0.01);
    expect(row.totalTokens).toBe(360);
    expect(row.turns).toBe(2);
    expect(row.rateLimitStatus).toBe("allowed_warning");
    expect(row.rateLimitPeakPct).toBe(84.5);
    expect(row.durationMs).toBeGreaterThanOrEqual(0);
    expect(row.errorClass).toBeNull();
  });

  test("a timed-out turn reports null economics, never a partial roll-up", async () => {
    await run(turn(STREAMED, Effect.fail(new TimedOut({ timeoutMs: 60_000 }))));

    const row = onlyRow();
    expect(row.outcome).toBe("timeout");
    expect(row.errorClass).toBe("TimedOut");
    expect(row.errorMessage).toBe("exceeded the 60000ms cap");
    expect(row.costUsd).toBeNull();
    expect(row.totalTokens).toBeNull();
    expect(row.turns).toBeNull();
    expect(row.inputTokens).toBeNull();
    expect(row.outputTokens).toBeNull();
    // how far it got is still on the row: that is what makes a kill worth reading
    expect(row.toolCalls).toBe(1);
    expect(row.eventsSeen).toBe(7);
    expect(row.durationMs).toBeGreaterThanOrEqual(0);
  });

  test("a stream that stopped without a terminus is its own outcome", async () => {
    await run(turn(STREAMED, Effect.void));

    const row = onlyRow();
    expect(row.outcome).toBe("no_terminal_event");
    expect(row.errorClass).toBe("NoTerminalEvent");
    expect(row.errorMessage).toContain("7 events");
    expect(row.costUsd).toBeNull();
  });

  test("an interrupted turn leaves one row with null economics", async () => {
    // Killed from outside mid-stream, which is what a stop command does. This is
    // the path that leaves no row at all when an emit sits after the work.
    await run(
      Effect.gen(function* () {
        const started = yield* Deferred.make<void>();
        const fiber = yield* Effect.forkChild(
          turn(
            STREAMED,
            Effect.gen(function* () {
              yield* Deferred.succeed(started, undefined);
              return yield* Effect.never;
            })
          )
        );
        yield* Deferred.await(started);
        yield* Fiber.interrupt(fiber);
      })
    );

    const row = onlyRow();
    expect(row.outcome).toBe("interrupted");
    expect(row.errorClass).toBe("Interrupted");
    expect(row.costUsd).toBeNull();
    expect(row.totalTokens).toBeNull();
    expect(row.turns).toBeNull();
  });

  test("a defect is named by the classifier rather than left unread", async () => {
    await run(turn(STREAMED, Effect.die(new Error("spawn claude ENOENT"))));

    const row = onlyRow();
    expect(row.outcome).toBe("errored");
    expect(row.errorClass).toBe("ProviderCrashed");
    expect(row.errorMessage).toBe("spawn claude ENOENT");
  });

  test("provider text reaches the row sanitized", async () => {
    await run(
      turn(
        STREAMED,
        Effect.fail(
          new ProviderCrashed({
            cause: null,
            message: "refused:  Authorization: Bearer abc.def-123",
          })
        )
      )
    );

    expect(onlyRow().errorMessage).toBe("refused: Authorization: [redacted]");
    // The row read the sanitizer's answer; only the file can say the token was
    // never written in the first place.
    expect(ledgerText()).not.toContain("abc.def-123");
  });

  test("the row survives a Warn floor that silences ordinary log lines", async () => {
    await run(
      Effect.gen(function* () {
        yield* Effect.logInfo("narration that should be dropped");
        return yield* turn([...STREAMED, RESULT], Effect.void);
      }),
      "Warn"
    );

    expect(capture.events).toHaveLength(1);
    // the only line that reached a logger is the wide event itself
    expect(capture.lines).toHaveLength(1);
    expect(readRows()).toHaveLength(1);
  });
});
