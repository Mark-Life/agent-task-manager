import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { hostname, tmpdir } from "node:os";
import { join } from "node:path";
import { BunFileSystem } from "@effect/platform-bun";
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
import { defineEvent, outcomeField } from "./event";
import {
  emitEvent,
  outcomeOfExit,
  Telemetry,
  withWideEvent,
} from "./telemetry";

const SERVICE = "telemetry-test";

/** A unit of work defined the way a real emitter defines its own. */
const TestEvent = defineEvent("atm.test", {
  outcome: outcomeField(["at_capacity"]),
  promptChars: Schema.Number,
  provider: Schema.String,
});

// A content field cannot be added to an event: the row carries a measurement.
// @ts-expect-error prompt is a content-carrying field name
defineEvent("atm.rejected", { prompt: Schema.String });

/**
 * What the log annotation sinks receive. Open by nature: a logger is handed
 * whatever annotations the fiber carries, so this is `CurrentLogAnnotations`'
 * own type rather than a shape anything here declares.
 */
type Annotations = Record<string, unknown>;

/**
 * One stored row, decoded through the same `rowSchema` the consumers read it
 * with.
 *
 * `defineEvent` builds `encode` and `rowSchema` from one fields object, so a
 * renamed field moves both at once and is a compile error. The half that can
 * genuinely drift is the one this file's own emitter spells by hand — `ts`, the
 * `event` tag and the environment stamp — and that is what the decode holds.
 */
type Row = typeof TestEvent.rowSchema.Type;

const decodeRow = Schema.decodeUnknownSync(TestEvent.rowSchema);

const baseInput = (
  over: Partial<Parameters<typeof TestEvent.encode>[0]> = {}
) =>
  ({
    costUsd: 0.01,
    durationMs: 5000,
    errorClass: null,
    errorMessage: null,
    outcome: "done",
    phase: "end",
    promptChars: 42,
    provider: "claude",
    queueWaitMs: 12,
    runId: "r-1",
    sessionId: "s-1",
    spanId: null,
    taskId: "t-1",
    totalTokens: 1234,
    traceId: null,
    turns: 2,
    workspaceId: "w-1",
    ...over,
  }) satisfies Parameters<typeof TestEvent.encode>[0];

/** Captures the wide event by its marker, and every log line for comparison. */
const captureLogger = (events: Annotations[], lines: Annotations[]) =>
  Logger.make((options) => {
    const annotations = options.fiber.getRef(References.CurrentLogAnnotations);
    lines.push({ ...annotations });
    if (annotations.event === TestEvent.marker) {
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
  directory = mkdtempSync(join(tmpdir(), "telemetry-"));
  capture = { events: [], lines: [] };
});

afterEach(() => {
  rmSync(directory, { force: true, recursive: true });
});

const run = <A>(
  program: Effect.Effect<A, never, Telemetry>,
  options: {
    readonly directory?: string;
    readonly level?: LogLevel.LogLevel;
  } = {}
) =>
  Effect.runPromise(
    program.pipe(
      Effect.provide(
        testLayer(
          options.directory ?? directory,
          capture,
          options.level ?? "Info"
        )
      )
    )
  );

/** One ledger line, or null where the line is not JSON at all. */
const jsonOf = (line: string): unknown => {
  try {
    return JSON.parse(line);
  } catch {
    return null;
  }
};

/**
 * Whether a parsed line is this unit's row, read off the parsed `event` field.
 * A substring test over the line would also match the marker inside a field
 * value and hand a foreign row to the decoder, failing the test for the wrong
 * reason.
 */
const isTestRow = (value: unknown) =>
  typeof value === "object" &&
  value !== null &&
  "event" in value &&
  value.event === TestEvent.marker;

const readRows = (path: string): readonly Row[] =>
  readFileSync(path, "utf-8")
    .split("\n")
    .map(jsonOf)
    .filter(isTestRow)
    .map((row) => decodeRow(row));

const ledgerPath = () => join(directory, `${SERVICE}.jsonl`);

/**
 * The ledger as bytes, which is what an assertion about a secret has to be made
 * against. `SanitizedText` runs `clipError` on decode as well as on encode, so
 * a decoded row would be showing the reader's own redaction rather than the
 * emitter's.
 */
const ledgerText = () => readFileSync(ledgerPath(), "utf-8");

const withoutNulls = (row: Row) =>
  Object.fromEntries(Object.entries(row).filter(([, value]) => value !== null));

const START_ROW_OUTCOME = /start row carries no outcome/;
const END_ROW_OUTCOME = /end row must name its outcome/;

/** The single row a test just emitted. Fails loudly when nothing was written. */
const onlyRow = (path: string) => {
  const rows = readRows(path);
  const [row] = rows;
  if (!row) {
    throw new Error(`expected one row at ${path}, found ${rows.length}`);
  }
  return row;
};

describe("emitEvent", () => {
  test("writes exactly one row per terminus, to the ledger and the logger", async () => {
    await run(emitEvent(TestEvent, baseInput()));

    const rows = readRows(ledgerPath());
    expect(rows).toHaveLength(1);
    expect(capture.events).toHaveLength(1);
    const row = onlyRow(ledgerPath());
    expect(row.event).toBe("atm.test");
    expect(row.outcome).toBe("done");
    expect(row.costUsd).toBe(0.01);
    expect(row.runId).toBe("r-1");
    // An instant in the one spelling whose lexical order is its chronological
    // order, which is what every reader of the ledger sorts on.
    expect(new Date(row.ts).toISOString()).toBe(row.ts);
    // Both sinks carry the same record. They differ on one point only, and only
    // where a value is missing: the ledger stores a JSON null, the annotation
    // sinks drop the key, because an OTLP attribute cannot hold a null.
    expect(capture.events[0]).toEqual(withoutNulls(row));
  });

  test("annotations drop null fields so OTLP never exports the string 'null'", async () => {
    await run(emitEvent(TestEvent, baseInput({ costUsd: null, turns: null })));

    const annotations = capture.events[0] ?? {};
    expect(annotations).not.toHaveProperty("costUsd");
    expect(annotations).not.toHaveProperty("turns");
    // a field that does have a value is still carried, and still a number
    expect(annotations.totalTokens).toBe(1234);
    // the ledger keeps the nulls: absent and "no value" are different there
    expect(onlyRow(ledgerPath()).costUsd).toBeNull();
  });

  test("stamps the environment once, from config", async () => {
    await run(emitEvent(TestEvent, baseInput()));

    const row = onlyRow(ledgerPath());
    expect(row.version).toBe("1.2.3");
    expect(row.gitSha).toBe("abc1234");
    // Nothing configures the host: it is read off the machine writing the row.
    expect(row.host).toBe(hostname());
  });

  test("two emits append two rows", async () => {
    await run(
      Effect.gen(function* () {
        yield* emitEvent(TestEvent, baseInput({ runId: "r-1" }));
        yield* emitEvent(TestEvent, baseInput({ runId: "r-2" }));
      })
    );

    expect(readRows(ledgerPath()).map((row) => row.runId)).toEqual([
      "r-1",
      "r-2",
    ]);
  });

  test("a degraded outcome serializes null economics, never a fabricated 0", async () => {
    await run(
      emitEvent(
        TestEvent,
        baseInput({
          costUsd: null,
          durationMs: null,
          outcome: "interrupted",
          queueWaitMs: null,
          totalTokens: null,
          turns: null,
        })
      )
    );

    const row = onlyRow(ledgerPath());
    expect(row.outcome).toBe("interrupted");
    expect(row.costUsd).toBeNull();
    expect(row.turns).toBeNull();
    expect(row.totalTokens).toBeNull();
    expect(row.durationMs).toBeNull();
    expect(row.queueWaitMs).toBeNull();
  });

  test("survives a Warn floor that silences ordinary log lines", async () => {
    await run(
      Effect.gen(function* () {
        yield* Effect.logInfo("narration that should be dropped");
        yield* emitEvent(TestEvent, baseInput());
      }),
      { level: "Warn" }
    );

    expect(capture.events).toHaveLength(1);
    // the only line that reached a logger is the wide event itself
    expect(capture.lines).toHaveLength(1);
    expect(readRows(ledgerPath())).toHaveLength(1);
  });

  test("sanitizes free text through the schema", async () => {
    await run(
      emitEvent(
        TestEvent,
        baseInput({
          errorClass: "ProviderCrashed",
          errorMessage: "failed  with\nAuthorization: Bearer abc.def-123",
          outcome: "errored",
        })
      )
    );

    const row = onlyRow(ledgerPath());
    expect(row.errorMessage).toBe("failed with Authorization: [redacted]");
    expect(ledgerText()).not.toContain("abc.def-123");
  });

  test("a write fault never aborts the work it describes", async () => {
    // Point the ledger directory at a path under a real file: makeDirectory and
    // writeFileString both fail with ENOTDIR, so only the swallow lets the emit
    // resolve.
    const blocker = join(directory, "blocker");
    writeFileSync(blocker, "");
    const nested = join(blocker, "events");

    await expect(
      run(emitEvent(TestEvent, baseInput()), { directory: nested })
    ).resolves.toBeUndefined();
    expect(existsSync(nested)).toBe(false);
  });

  test("a throwing encode is a dropped row, not a failed run", async () => {
    const broken = {
      encode: () => {
        throw new Error("serializer exploded");
      },
      marker: "atm.test",
    };

    await expect(run(emitEvent(broken, undefined))).resolves.toBeUndefined();
    expect(existsSync(ledgerPath())).toBe(false);
  });
});

describe("the start row", () => {
  test("carries no outcome, because it has not ended", async () => {
    await run(
      emitEvent(
        TestEvent,
        baseInput({
          costUsd: null,
          durationMs: null,
          outcome: null,
          phase: "start",
          queueWaitMs: null,
          totalTokens: null,
          turns: null,
        })
      )
    );

    const row = onlyRow(ledgerPath());
    expect(row.phase).toBe("start");
    expect(row.outcome).toBeNull();
  });

  test("cannot serialize a terminal outcome", () => {
    expect(() =>
      TestEvent.encode(baseInput({ outcome: "done", phase: "start" }))
    ).toThrow(START_ROW_OUTCOME);
  });

  test("an end row must name its outcome", () => {
    expect(() =>
      TestEvent.encode(baseInput({ outcome: null, phase: "end" }))
    ).toThrow(END_ROW_OUTCOME);
  });
});

/**
 * Instruments a unit of work the way a real emitter does: the outcome and the
 * economics are read off the exit, so every terminus goes through one emit site.
 */
const instrumented = <A, E>(work: Effect.Effect<A, E>) =>
  work.pipe(
    withWideEvent(TestEvent, ({ durationMs, exit, spanId, traceId }) => {
      const outcome = outcomeOfExit(exit);
      const degraded = outcome !== "done";
      return baseInput({
        costUsd: degraded ? null : 0.01,
        durationMs,
        outcome,
        queueWaitMs: degraded ? null : 12,
        spanId,
        totalTokens: degraded ? null : 1234,
        traceId,
        turns: degraded ? null : 2,
      });
    })
  );

const runTerminus = <A, E>(work: Effect.Effect<A, E>) =>
  run(instrumented(work).pipe(Effect.exit));

describe("withWideEvent", () => {
  test("a success terminus leaves exactly one row", async () => {
    const exit = await runTerminus(Effect.succeed("ok"));

    expect(exit._tag).toBe("Success");
    const rows = readRows(ledgerPath());
    expect(rows).toHaveLength(1);
    expect(rows[0]?.outcome).toBe("done");
    expect(rows[0]?.costUsd).toBe(0.01);
    expect(rows[0]?.durationMs).toBeGreaterThanOrEqual(0);
  });

  test("a failure terminus leaves exactly one row, with null economics", async () => {
    const exit = await runTerminus(Effect.fail("provider crashed"));

    expect(exit._tag).toBe("Failure");
    const rows = readRows(ledgerPath());
    expect(rows).toHaveLength(1);
    expect(rows[0]?.outcome).toBe("errored");
    expect(rows[0]?.costUsd).toBeNull();
    expect(rows[0]?.turns).toBeNull();
  });

  test("a defect terminus leaves exactly one row", async () => {
    const exit = await runTerminus(Effect.die(new Error("boom")));

    expect(exit._tag).toBe("Failure");
    const rows = readRows(ledgerPath());
    expect(rows).toHaveLength(1);
    expect(rows[0]?.outcome).toBe("errored");
  });

  test("an interrupt terminus leaves exactly one row, with null economics", async () => {
    // The work never finishes on its own; it is killed from outside. This is the
    // path that leaves no row at all when an emit sits after the work instead of
    // on its exit.
    await run(
      Effect.gen(function* () {
        const started = yield* Deferred.make<void>();
        const fiber = yield* Effect.forkChild(
          instrumented(
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

    const rows = readRows(ledgerPath());
    expect(rows).toHaveLength(1);
    expect(rows[0]?.outcome).toBe("interrupted");
    expect(rows[0]?.costUsd).toBeNull();
    expect(rows[0]?.totalTokens).toBeNull();
  });
});
