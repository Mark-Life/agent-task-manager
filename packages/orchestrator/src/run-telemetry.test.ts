import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BunFileSystem } from "@effect/platform-bun";
import {
  type AgentSession,
  CostUsd,
  newAgentSessionId,
  newRunId,
  newTaskId,
  type Task,
  WorkspaceId,
} from "@workspace/domain";
import { hostRunLayout } from "@workspace/harness";
import { Telemetry } from "@workspace/telemetry";
import {
  ConfigProvider,
  DateTime,
  Deferred,
  Effect,
  Fiber,
  Layer,
  Logger,
  type LogLevel,
  Metric,
  Ref,
  References,
} from "effect";
import type {
  DispatchContext,
  RunFailed,
  RunFinished,
} from "./dispatch-context";
import { lostTerminus } from "./dispatch-context";
import { AlreadyLive, DispatchFailed } from "./errors";
import {
  makeRunProgress,
  observeRunProgress,
  RUN_EVENT_MARKER,
  type RunEventContext,
  type RunEventSettings,
  type RunProgress,
  withRunEvent,
} from "./run-telemetry";
import { workerAttachment } from "./subject";

const SERVICE = "run-telemetry-test";

type Row = Record<string, unknown>;

/** Captures the wide event by its marker, and every log line for comparison. */
const captureLogger = (events: Row[], lines: Row[]) =>
  Logger.make((options) => {
    const annotations = options.fiber.getRef(References.CurrentLogAnnotations);
    lines.push({ ...annotations });
    if (annotations.event === RUN_EVENT_MARKER) {
      events.push({ ...annotations });
    }
  });

interface Capture {
  readonly events: Row[];
  readonly lines: Row[];
}

const testLayer = (
  logDirectory: string,
  sink: Capture,
  level: LogLevel.LogLevel
) =>
  Layer.mergeAll(
    Telemetry.layer({ serviceName: SERVICE }).pipe(
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
    ),
    Logger.layer([captureLogger(sink.events, sink.lines)]),
    Layer.succeed(References.MinimumLogLevel, level)
  );

let directory: string;
let capture: Capture;

beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), "run-telemetry-"));
  capture = { events: [], lines: [] };
});

afterEach(() => {
  rmSync(directory, { force: true, recursive: true });
});

const ledgerPath = () => join(directory, `${SERVICE}.jsonl`);

const readRows = (): Row[] =>
  readFileSync(ledgerPath(), "utf-8")
    .split("\n")
    .filter((line) => line.trim().length > 0)
    .map((line) => JSON.parse(line) as Row);

/** The two rows one run writes. Fails loudly when the count is not two. */
const bothRows = () => {
  const rows = readRows();
  const [start, end] = rows;
  if (!(start && end) || rows.length !== 2) {
    throw new Error(`expected exactly two rows, found ${rows.length}`);
  }
  return { end, start };
};

/** The terminus row on its own, which is what most assertions are about. */
const endRow = () => bothRows().end;

const at = DateTime.makeUnsafe("2026-08-02T10:00:00.000Z");
const workspaceId = WorkspaceId.make("ws-1");
const taskId = newTaskId();
const runId = newRunId();
const sessionId = newAgentSessionId();

/** A clone URL with a credential in it, which must never reach a row. */
const REPO_URL =
  "https://x-access-token:ghp_abcdefghijklmnop@github.com/acme/api.git";

const task: Task = {
  acceptance: null,
  brief: "ship it",
  createdAt: at,
  dispatchTraceparent: null,
  id: taskId,
  metadata: {},
  nextSessionId: null,
  nextSessionNew: false,
  parentTaskId: null,
  parkedUntil: null,
  projectId: null,
  prUrl: null,
  rank: 0,
  repoUrl: REPO_URL,
  sandboxImage: null,
  status: "in_progress",
  statusChangedAt: at,
  title: "ship it",
  updatedAt: at,
  workspaceId,
};

const session: AgentSession = {
  createdAt: at,
  endedAt: null,
  errorMessage: null,
  id: sessionId,
  provider: "claude",
  providerSessionId: "provider-sess-1",
  status: "finished",
  taskId,
  threadId: null,
  unreadWatermarkAt: null,
  unreadWatermarkId: null,
  updatedAt: at,
  workspaceId,
};

const dispatch: DispatchContext = {
  actor: { kind: "orchestrator", loopInstance: "loop-1", runId },
  attached: workerAttachment(task),
  attempt: 2,
  image: "atm.local/base:2026-08-01",
  layout: hostRunLayout({ dataRoot: ".data", runId }),
  project: null,
  provider: "claude",
  queueWaitMs: 4200,
  repoUrl: REPO_URL,
  runId,
  session: {
    mode: "resumed",
    providerSessionId: "provider-sess-1",
    selected: "latest",
    session,
  },
  spanId: "span-1",
  traceId: "trace-1",
  traceparent: "00-trace-1-span-1-01",
  trigger: "status_change",
};

const settings: RunEventSettings = {
  maxAttempts: 5,
  sandboxKind: "docker",
};

/** The work lane's cap, which is what a worker run's row reports. */
const WORK_CAPACITY = 2;

const finished: RunFinished = {
  costUsd: CostUsd.make("0.420000"),
  durationMs: 91_000,
  exitCode: 0,
  finalText: "opened the PR",
  kind: "finished",
  providerSessionId: "provider-sess-2",
  totalTokens: 4200,
  turns: 7,
};

const failed: RunFailed = {
  costUsd: null,
  durationMs: 12_000,
  errorClass: "ProviderCrashed",
  errorMessage: "the provider stream ended",
  exitCode: 1,
  finalText: "",
  kind: "failed",
  providerSessionId: "provider-sess-2",
  totalTokens: null,
  turns: null,
};

const lost = lostTerminus({
  eventsSeen: 12,
  exitCode: 137,
  finalText: "half a thought",
  providerSessionId: null,
});

/** What the loop folds in on a run that reached its close-out. */
const CLOSED_OUT: Partial<RunProgress> = {
  artifactsWritten: 3,
  branch: "atm/task-1",
  eventsSeen: 84,
  messageFallback: true,
  promptChars: 1200,
};

/**
 * One run: what the loop observed on its way through, then whatever it did to
 * end. The shape a real lifecycle has — fold each fact as it arrives, and let
 * the combinator read the accumulator on the way out.
 */
const oneRun = <A, E>(
  observed: readonly Partial<RunProgress>[],
  ending: Effect.Effect<A, E>,
  poolDepth = 1
) =>
  Effect.gen(function* () {
    const progress = yield* makeRunProgress;
    const work = Effect.gen(function* () {
      for (const patch of observed) {
        yield* observeRunProgress(progress, patch);
      }
      return yield* ending;
    });
    const context: RunEventContext = {
      dispatch,
      lane: "work",
      laneCapacity: WORK_CAPACITY,
      poolDepth,
      progress,
      settings,
    };
    return yield* work.pipe(withRunEvent(context));
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

describe("withRunEvent", () => {
  test("writes a start row and a terminus row sharing one runId", async () => {
    await run(
      oneRun([CLOSED_OUT, { terminus: finished }], Effect.succeed("ok"))
    );

    const { end, start } = bothRows();
    expect(capture.events).toHaveLength(2);
    expect(start.event).toBe(RUN_EVENT_MARKER);
    expect(start.phase).toBe("start");
    expect(end.phase).toBe("end");
    // the join key: without it a start with no terminus cannot be reconciled
    expect(start.runId).toBe(runId);
    expect(end.runId).toBe(runId);
  });

  test("the start row carries the claim and nothing it cannot know yet", async () => {
    await run(oneRun([], Effect.succeed("ok"), 2));

    const { start } = bothRows();
    // the ids every other event joins on
    expect(start.taskId).toBe(taskId);
    expect(start.sessionId).toBe(sessionId);
    expect(start.workspaceId).toBe(workspaceId);
    expect(start.traceId).toBe("trace-1");
    expect(start.spanId).toBe("span-1");
    // what was decided at the claim
    expect(start.attempt).toBe(2);
    expect(start.maxAttempts).toBe(5);
    expect(start.poolDepth).toBe(2);
    expect(start.maxConcurrency).toBe(2);
    expect(start.provider).toBe("claude");
    expect(start.kind).toBe("docker");
    expect(start.image).toBe("atm.local/base:2026-08-01");
    expect(start.sessionMode).toBe("resumed");
    expect(start.sessionSelected).toBe("latest");
    expect(start.taskStatus).toBe("in_progress");
    expect(start.trigger).toBe("status_change");
    expect(start.providerSessionId).toBe("provider-sess-1");
    // the wait happened before the run existed, so it is real on both rows
    expect(start.queueWaitMs).toBe(4200);
    // a start row has not ended: no outcome, no economics, no lease duration
    expect(start.outcome).toBeNull();
    expect(start.costUsd).toBeNull();
    expect(start.durationMs).toBeNull();
    expect(start.totalTokens).toBeNull();
    expect(start.turns).toBeNull();
    expect(start.leaseDurationMs).toBeNull();
    expect(start.promptChars).toBeNull();
    expect(start.errorClass).toBeNull();
  });

  test("a credential in the repo URL never reaches a row", async () => {
    await run(oneRun([], Effect.succeed("ok")));

    for (const row of readRows()) {
      expect(row.repo).toBe("acme/api");
      expect(JSON.stringify(row)).not.toContain("ghp_");
    }
  });

  test("a finished run reports the terminus economics and what it left behind", async () => {
    await run(
      oneRun([CLOSED_OUT, { terminus: finished }], Effect.succeed("ok"))
    );

    const end = endRow();
    expect(end.outcome).toBe("done");
    expect(end.errorClass).toBeNull();
    expect(end.errorMessage).toBeNull();
    // the roll-up the provider reported
    expect(end.costUsd).toBe(0.42);
    expect(end.durationMs).toBe(91_000);
    expect(end.totalTokens).toBe(4200);
    expect(end.turns).toBe(7);
    expect(end.exitCode).toBe(0);
    // the provider's own id wins over the one the resume was pointed at
    expect(end.providerSessionId).toBe("provider-sess-2");
    // what the loop accumulated
    expect(end.artifactsWritten).toBe(3);
    expect(end.messageFallback).toBe(true);
    expect(end.eventsSeen).toBe(84);
    expect(end.promptChars).toBe(1200);
    expect(end.branch).toBe("atm/task-1");
    // measured by the loop across every exit path
    expect(typeof end.leaseDurationMs).toBe("number");
  });

  test("the row names the commit each shared scope stood at", async () => {
    await run(
      oneRun(
        [
          {
            projectCommit: "b2c3d4e5f60718293a4b5c6d7e8f90a1b2c3d4e5",
            workspaceCommit: "a1b2c3d4e5f60718293a4b5c6d7e8f90a1b2c3d4",
          },
          { terminus: finished },
        ],
        Effect.succeed("ok")
      )
    );

    const { end, start } = bothRows();
    // Which rules the run had, as bytes somebody can still read.
    expect(end.workspaceCommit).toBe(
      "a1b2c3d4e5f60718293a4b5c6d7e8f90a1b2c3d4"
    );
    expect(end.projectCommit).toBe("b2c3d4e5f60718293a4b5c6d7e8f90a1b2c3d4e5");
    // The start row is written before anything is folded in, like every other
    // fact the loop learns on its way through.
    expect(start.workspaceCommit).toBeNull();
    expect(start.projectCommit).toBeNull();
  });

  test("a scope with no history leaves a null rather than failing the row", async () => {
    await run(oneRun([{ terminus: finished }], Effect.succeed("ok")));

    const end = endRow();
    expect(end.workspaceCommit).toBeNull();
    expect(end.projectCommit).toBeNull();
    expect(end.outcome).toBe("done");
  });

  test("a failed terminus keeps its class and whatever it did report", async () => {
    await run(oneRun([{ terminus: failed }], Effect.succeed("ok")));

    const end = endRow();
    expect(end.outcome).toBe("errored");
    expect(end.errorClass).toBe("ProviderCrashed");
    expect(end.errorMessage).toBe("the provider stream ended");
    // a failed turn still burned twelve seconds of model time, and that is real
    expect(end.durationMs).toBe(12_000);
    // what it never reported stays null rather than becoming a zero
    expect(end.costUsd).toBeNull();
    expect(end.totalTokens).toBeNull();
    expect(end.turns).toBeNull();
  });

  test("a run nobody heard from is lost, with no numbers at all", async () => {
    await run(
      oneRun([{ eventsSeen: 12, terminus: lost }], Effect.succeed("ok"))
    );

    const end = endRow();
    expect(end.outcome).toBe("lost");
    expect(end.errorClass).toBe("NoTerminalEvent");
    expect(end.costUsd).toBeNull();
    expect(end.durationMs).toBeNull();
    expect(end.totalTokens).toBeNull();
    expect(end.turns).toBeNull();
    expect(end.exitCode).toBe(137);
  });

  test("a clean exit that never produced a terminus is still lost", async () => {
    await run(oneRun([{ eventsSeen: 2 }], Effect.succeed("ok")));

    const end = endRow();
    expect(end.outcome).toBe("lost");
    expect(end.errorMessage).toContain("2 events and no terminus");
  });

  test("an interrupted run leaves both rows and null economics", async () => {
    // Killed from outside mid-run, which is what a stop command and a shutdown
    // both do. This is the path that leaves no terminus at all when an emit
    // sits after the work instead of on its exit.
    await run(
      Effect.gen(function* () {
        const started = yield* Deferred.make<void>();
        const fiber = yield* Effect.forkChild(
          oneRun(
            [CLOSED_OUT, { terminus: finished }],
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

    const { end } = bothRows();
    expect(end.outcome).toBe("interrupted");
    // a stop is not a thing that went wrong with a run
    expect(end.errorClass).toBeNull();
    // even a captured terminus is dropped: its numbers describe a run that did
    // not finish, and a partial cost stored as final is one someone averages
    expect(end.costUsd).toBeNull();
    expect(end.durationMs).toBeNull();
    expect(end.totalTokens).toBeNull();
    expect(end.turns).toBeNull();
    // what the run did reach is still on the row
    expect(end.eventsSeen).toBe(84);
  });

  test("a parked attempt is one row, not a second emit", async () => {
    await run(
      oneRun([{ parked: true, terminus: failed }], Effect.succeed("ok"))
    );

    const rows = readRows();
    expect(rows).toHaveLength(2);
    const end = endRow();
    expect(end.outcome).toBe("parked");
    // the attempt that ran out of rope keeps the reason it failed for
    expect(end.errorClass).toBe("ProviderCrashed");
  });

  test("a dispatch the loop declined is skipped, not errored", async () => {
    await run(
      oneRun(
        [],
        Effect.fail(
          new AlreadyLive({ runId, subject: { id: taskId, kind: "task" } })
        )
      )
    );

    const end = endRow();
    expect(end.outcome).toBe("skipped");
    expect(end.errorClass).toBe("AlreadyLive");
    expect(end.costUsd).toBeNull();
  });

  test("a failing exit is classified and its text sanitized", async () => {
    await run(
      oneRun(
        [],
        Effect.fail(
          new DispatchFailed({
            cause: null,
            detail: "clone  failed: Authorization: Bearer abc.def-123",
            subject: { id: taskId, kind: "task" },
          })
        )
      )
    );

    const end = endRow();
    expect(end.outcome).toBe("errored");
    expect(end.errorClass).toBe("DispatchFailed");
    expect(end.errorMessage).toBe("clone failed: Authorization: [redacted]");
  });

  test("a failing exit outranks a terminus the loop had already recorded", async () => {
    await run(
      oneRun(
        [{ terminus: finished }],
        Effect.fail(
          new DispatchFailed({
            cause: null,
            detail: "ingest died",
            subject: { id: taskId, kind: "task" },
          })
        )
      )
    );

    // the run's record could not be written, so the row is not green
    expect(endRow().outcome).toBe("errored");
  });

  test("a defect leaves both rows rather than one and a crash", async () => {
    await run(oneRun([], Effect.die(new Error("boom"))));

    expect(readRows()).toHaveLength(2);
    expect(endRow().outcome).toBe("errored");
  });

  test("both rows survive a Warn floor that silences ordinary log lines", async () => {
    await run(
      Effect.gen(function* () {
        yield* Effect.logInfo("narration that should be dropped");
        return yield* oneRun([{ terminus: finished }], Effect.succeed("ok"));
      }),
      "Warn"
    );

    expect(capture.events).toHaveLength(2);
    // the only lines that reached a logger are the two wide events
    expect(capture.lines).toHaveLength(2);
    expect(readRows()).toHaveLength(2);
  });
});

/** Every series of one metric after the work, with its attribute keys. */
const seriesOf = (name: string) =>
  Effect.gen(function* () {
    const snapshot = yield* Metric.snapshot;
    return snapshot.filter((metric) => metric.id === name);
  });

type Series = Effect.Success<ReturnType<typeof seriesOf>>;

const totalCount = (series: Series) =>
  series.reduce(
    (total, metric) =>
      total + Number((metric.state as { count: number }).count),
    0
  );

const attributeKeys = (series: Series) =>
  series.map((metric) => Object.keys(metric.attributes ?? {}).sort());

/** Runs the work and reports one metric's series before and after it. */
const measure = <A, E>(name: string, work: Effect.Effect<A, E, Telemetry>) =>
  Effect.runPromise(
    Effect.gen(function* () {
      const before = totalCount(yield* seriesOf(name));
      yield* work.pipe(Effect.exit);
      const series = yield* seriesOf(name);
      return { delta: totalCount(series) - before, series };
    }).pipe(Effect.provide(testLayer(directory, capture, "Info")))
  );

describe("the metrics derived from the run event", () => {
  test("atm_runs_total counts one run, tagged only by bounded values", async () => {
    const measured = await measure(
      "atm_runs_total",
      oneRun([{ terminus: finished }], Effect.succeed("ok"))
    );

    expect(measured.delta).toBe(1);
    for (const keys of attributeKeys(measured.series)) {
      // pins the tag boundary: an unbounded tag added later fails here
      expect(keys).toEqual(["kind", "outcome", "provider", "role"]);
    }
    expect(
      measured.series.map((metric) => metric.attributes ?? {})
    ).toContainEqual({
      kind: "docker",
      outcome: "done",
      provider: "claude",
      role: "worker",
    });
  });

  test("atm_retries_total counts the attempts that stamped a backoff", async () => {
    const measured = await measure(
      "atm_retries_total",
      oneRun([{ retryInMs: 60_000, terminus: failed }], Effect.succeed("ok"))
    );

    expect(measured.delta).toBe(1);
    for (const keys of attributeKeys(measured.series)) {
      expect(keys).toEqual(["provider"]);
    }
  });

  test("atm_parked_total counts the ladders that ran out", async () => {
    const measured = await measure(
      "atm_parked_total",
      oneRun([{ parked: true, terminus: failed }], Effect.succeed("ok"))
    );

    expect(measured.delta).toBe(1);
    for (const keys of attributeKeys(measured.series)) {
      expect(keys).toEqual(["provider"]);
    }
  });

  test("atm_quota_pause_total counts the dispatches an allowance refused", async () => {
    const measured = await measure(
      "atm_quota_pause_total",
      oneRun(
        [],
        Effect.fail(
          new AlreadyLive({ runId, subject: { id: taskId, kind: "task" } })
        )
      )
    );

    // a skip that was not about quota leaves this counter alone
    expect(measured.delta).toBe(0);

    const paused = await measure(
      "atm_quota_pause_total",
      oneRun(
        [
          {
            terminus: {
              ...failed,
              errorClass: "QuotaPaused",
            },
          },
        ],
        Effect.succeed("ok")
      )
    );

    expect(paused.delta).toBe(1);
    for (const keys of attributeKeys(paused.series)) {
      expect(keys).toEqual(["provider"]);
    }
  });

  test("atm_run_duration_ms records every run, split by ending", async () => {
    const measured = await measure(
      "atm_run_duration_ms",
      oneRun([{ terminus: finished }], Effect.succeed("ok"))
    );

    expect(measured.delta).toBe(1);
    for (const keys of attributeKeys(measured.series)) {
      expect(keys).toEqual(["outcome", "provider"]);
    }
  });

  test("atm_run_cost_usd records only the runs that reported a cost", async () => {
    const measured = await measure(
      "atm_run_cost_usd",
      oneRun([{ terminus: finished }], Effect.succeed("ok"))
    );

    expect(measured.delta).toBe(1);
    for (const keys of attributeKeys(measured.series)) {
      expect(keys).toEqual(["provider"]);
    }

    // a run with no economics moves no percentile
    const degraded = await measure(
      "atm_run_cost_usd",
      oneRun([{ terminus: lost }], Effect.succeed("ok"))
    );
    expect(degraded.delta).toBe(0);
  });

  test("atm_run_turns records only the runs that reported turns", async () => {
    const measured = await measure(
      "atm_run_turns",
      oneRun([{ terminus: finished }], Effect.succeed("ok"))
    );

    expect(measured.delta).toBe(1);
    for (const keys of attributeKeys(measured.series)) {
      expect(keys).toEqual(["provider"]);
    }
  });
});

describe("observeRunProgress", () => {
  test("folds each fact in without dropping the ones already known", async () => {
    const progress = await Effect.runPromise(
      Effect.gen(function* () {
        const cell = yield* makeRunProgress;
        yield* observeRunProgress(cell, { promptChars: 1200 });
        yield* observeRunProgress(cell, { branch: "atm/task-1" });
        yield* observeRunProgress(cell, { eventsSeen: 84, terminus: finished });
        return yield* Ref.get(cell);
      })
    );

    expect(progress).toEqual({
      artifactsWritten: 0,
      branch: "atm/task-1",
      eventsSeen: 84,
      instructionBytes: null,
      messageFallback: false,
      parked: false,
      projectCommit: null,
      promptChars: 1200,
      prUrl: null,
      retryInMs: null,
      terminus: finished,
      workspaceCommit: null,
    });
  });
});
