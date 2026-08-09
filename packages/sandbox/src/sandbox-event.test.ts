import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BunFileSystem } from "@effect/platform-bun";
import { newRunId, newTaskId, WorkspaceId } from "@workspace/domain";
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
  Ref,
  References,
} from "effect";
import { ImageMissing } from "./errors";
import { defaultHardening } from "./hardening";
import { mountsFor } from "./mounts";
import {
  hardeningProfileOf,
  makeSandboxProgress,
  observeSandboxProgress,
  runsAsRoot,
  SANDBOX_EVENT_MARKER,
  type SandboxContext,
  type SandboxProgress,
  subcommandOf,
  subprocessSpanName,
  withSandboxEvent,
} from "./sandbox-event";
import type { SandboxResult, SandboxSpec } from "./spec";

const SERVICE = "sandbox-test";
const COUNTER = "atm_sandbox_runs_total";

type Row = Record<string, unknown>;

/** Captures the wide event by its marker, and every log line for comparison. */
const captureLogger = (events: Row[], lines: Row[]) =>
  Logger.make((options) => {
    const annotations = options.fiber.getRef(References.CurrentLogAnnotations);
    lines.push({ ...annotations });
    if (annotations.event === SANDBOX_EVENT_MARKER) {
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
  directory = mkdtempSync(join(tmpdir(), "sandbox-event-"));
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

/** The single row a container just wrote. Fails loudly when the count is not one. */
const onlyRow = () => {
  const rows = readRows();
  const [row] = rows;
  if (!row || rows.length !== 1) {
    throw new Error(`expected exactly one row, found ${rows.length}`);
  }
  return row;
};

const RUN_ID = newRunId();
const TASK_ID = newTaskId();
const WORKSPACE_ID = WorkspaceId.make("ws-1");

const MOUNTS = mountsFor({
  agentHomeDir: "/home/op/.claude-task-management",
  cacheDir: "/data/caches",
  composedSkillsDir: null,
  globalArtifactsDir: "/data/artifacts/global",
  labels: { project: "Atlas", repo: "mark-life/atlas", task: "Ship it" },
  projectArtifactsDir: "/data/artifacts/project-1",
  runDir: "/data/runs/run-1",
  taskArtifactsDir: "/data/tasks/task-1/artifacts",
  workspaceDir: "/data/runs/run-1/workspace",
});

const spec: SandboxSpec = {
  args: ["-lc", "bun run agent"],
  command: "bash",
  env: { EVENT_LOG_DIR: "/run/events" },
  hardening: defaultHardening,
  identity: {
    runId: RUN_ID,
    sessionId: null,
    taskId: TASK_ID,
    traceparent: null,
    workspaceId: WORKSPACE_ID,
  },
  image: "atm/base:2026-08-01",
  mounts: MOUNTS,
  timeoutMs: 1_800_000,
  workingDir: "/workspace",
};

/** What a container that ran to completion hands back. */
const resultOf = (over: Partial<SandboxResult> = {}): SandboxResult => ({
  containerId: "c0ffee123456",
  exitCode: 0,
  image: spec.image,
  imagePulled: false,
  kind: "docker",
  mountCount: MOUNTS.length,
  oomKilled: false,
  peakMemoryBytes: 734_003_200,
  teardown: "removed",
  wallClockMs: 42_000,
  ...over,
});

/** What an implementation folds in as it learns it. */
const STARTED: Partial<SandboxProgress> = {
  containerId: "c0ffee123456",
  imagePulled: true,
};

/**
 * One container: what the implementation observed on its way through, then
 * whatever it did to end. The shape a real implementation has — fold each fact
 * as it arrives, and let the combinator read the accumulator on the way out.
 */
const container = (
  observed: readonly Partial<SandboxProgress>[],
  ending: Effect.Effect<SandboxResult, ImageMissing>
) =>
  Effect.gen(function* () {
    const progress = yield* makeSandboxProgress;
    const work = Effect.gen(function* () {
      for (const patch of observed) {
        yield* observeSandboxProgress(progress, patch);
      }
      return yield* ending;
    });
    const context: SandboxContext = { kind: "docker", progress, spec };
    return yield* work.pipe(withSandboxEvent(context));
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

describe("subprocessSpanName", () => {
  test("labels a subprocess by its subcommand", () => {
    expect(subprocessSpanName("docker", ["run", "--rm", "alpine"])).toBe(
      "docker.run"
    );
    expect(subprocessSpanName("gh", ["pr", "create", "--title", "x"])).toBe(
      "gh.pr"
    );
    // the executable's own path is not part of the name
    expect(subprocessSpanName("/usr/bin/git", ["fetch", "--prune"])).toBe(
      "git.fetch"
    );
  });

  test("a flag's value is never mistaken for the subcommand", () => {
    expect(
      subprocessSpanName("git", ["-C", "/data/repos/acme.git", "clone", "x"])
    ).toBe("git.clone");
    // an inline value belongs to its own flag, so the next token still counts
    expect(subprocessSpanName("docker", ["--context=remote", "run"])).toBe(
      "docker.run"
    );
  });

  test("a credential in the argv never reaches the span name", () => {
    const args = [
      "clone",
      "https://x-access-token:ghp_abcdefghijklmnop@github.com/acme/api.git",
      "/workspace",
    ];

    const name = subprocessSpanName("git", args);

    expect(name).toBe("git.clone");
    expect(name).not.toContain("ghp_");
    expect(name).not.toContain("github.com");
  });

  test("an argv with no readable subcommand is named, not guessed", () => {
    expect(subcommandOf(["--version"])).toBeNull();
    // an object id is a token, not a word: the length cap keeps it out
    expect(
      subcommandOf(["7f3a9c2e1b4d8a6f0c5e2947b1d3f8a60c4e7b29"])
    ).toBeNull();
    // so is anything carrying path or URL punctuation
    expect(subcommandOf(["/usr/local/bin/agent"])).toBeNull();
    expect(subcommandOf(["ref=refs/heads/main"])).toBeNull();
    expect(subprocessSpanName("git", ["--version"])).toBe("git.exec");
  });
});

describe("the hardening projection", () => {
  test("names the default confinement and anything that is not it", () => {
    expect(hardeningProfileOf(defaultHardening)).toBe("default");
    expect(hardeningProfileOf({ ...defaultHardening, memoryMb: 8192 })).toBe(
      "custom"
    );
    expect(hardeningProfileOf({ ...defaultHardening, capDrop: [] })).toBe(
      "custom"
    );
    expect(hardeningProfileOf({ ...defaultHardening, tmpfs: [] })).toBe(
      "custom"
    );
  });

  test("reads root off the uid half, including the empty user", () => {
    expect(runsAsRoot("1000:1000")).toBe(false);
    expect(runsAsRoot("0:0")).toBe(true);
    expect(runsAsRoot("root")).toBe(true);
    expect(runsAsRoot("")).toBe(true);
  });
});

describe("withSandboxEvent", () => {
  test("a finished container leaves exactly one atm.sandbox row", async () => {
    await run(container([STARTED], Effect.succeed(resultOf())));

    expect(capture.events).toHaveLength(1);
    const row = onlyRow();
    expect(row.event).toBe(SANDBOX_EVENT_MARKER);
    expect(row.phase).toBe("end");
    expect(row.outcome).toBe("done");
    // the ids the loop minted, so the row joins the run and the turns inside it
    expect(row.runId).toBe(RUN_ID);
    expect(row.taskId).toBe(TASK_ID);
    expect(row.workspaceId).toBe(WORKSPACE_ID);
    expect(row.sessionId).toBeNull();
    // what was asked for
    expect(row.kind).toBe("docker");
    expect(row.image).toBe("atm/base:2026-08-01");
    expect(row.mountCount).toBe(7);
    expect(row.timeoutMs).toBe(1_800_000);
    // the confinement that was applied
    expect(row.hardeningProfile).toBe("default");
    expect(row.memoryLimitMb).toBe(defaultHardening.memoryMb);
    expect(row.cpuLimit).toBe(defaultHardening.cpus);
    expect(row.pidsLimit).toBe(defaultHardening.pidsLimit);
    expect(row.networkMode).toBe("bridge");
    expect(row.readOnlyRootfs).toBe(false);
    expect(row.runAsRoot).toBe(false);
    // what the container did
    expect(row.containerId).toBe("c0ffee123456");
    expect(row.exitCode).toBe(0);
    expect(row.oomKilled).toBe(false);
    expect(row.peakMemoryBytes).toBe(734_003_200);
    expect(row.containerMs).toBe(42_000);
    expect(row.teardown).toBe("removed");
    // the result outranks the accumulator: the pull flag on it is the real one
    expect(row.imagePulled).toBe(false);
    expect(typeof row.durationMs).toBe("number");
    expect(row.errorClass).toBeNull();
  });

  test("a non-zero exit is data, not a failed sandbox", async () => {
    await run(container([STARTED], Effect.succeed(resultOf({ exitCode: 1 }))));

    const row = onlyRow();
    // the agent's test suite failed; the container ran exactly as asked
    expect(row.outcome).toBe("done");
    expect(row.exitCode).toBe(1);
    expect(row.errorClass).toBeNull();
  });

  test("an OOM kill reported as data is still an oom_killed row", async () => {
    await run(
      container(
        [STARTED],
        Effect.succeed(
          resultOf({ exitCode: 137, oomKilled: true, teardown: "removed" })
        )
      )
    );

    const row = onlyRow();
    expect(row.outcome).toBe("oom_killed");
    expect(row.errorClass).toBe("OomKilled");
    expect(row.oomKilled).toBe(true);
    // the limit that was hit is on the row, because that is what is acted on
    expect(row.memoryLimitMb).toBe(2048);
  });

  test("a start failure reports null economics and no container facts", async () => {
    await run(
      container(
        [],
        Effect.fail(
          new ImageMissing({
            detail: "unable to find image 'atm/base:2026-08-01' locally",
            image: spec.image,
          })
        )
      )
    );

    const row = onlyRow();
    expect(row.outcome).toBe("start_failed");
    expect(row.errorClass).toBe("ImageMissing");
    expect(row.errorMessage).toContain("unable to find image");
    // economics belong to the turn inside the container, and there was none
    expect(row.costUsd).toBeNull();
    expect(row.totalTokens).toBeNull();
    expect(row.turns).toBeNull();
    expect(row.queueWaitMs).toBeNull();
    // nothing ran, so nothing was observed — never a fabricated 0
    expect(row.containerId).toBeNull();
    expect(row.exitCode).toBeNull();
    expect(row.peakMemoryBytes).toBeNull();
    expect(row.containerMs).toBeNull();
    expect(row.teardown).toBeNull();
    // what was asked for is still on the row: that is what makes it readable
    expect(row.image).toBe("atm/base:2026-08-01");
    expect(row.mountCount).toBe(7);
    expect(typeof row.durationMs).toBe("number");
  });

  test("what the container reached is kept on a failing row", async () => {
    await run(
      container(
        [STARTED, { exitCode: 137, teardown: "failed" }],
        Effect.fail(
          new ImageMissing({ detail: "pull access denied", image: spec.image })
        )
      )
    );

    const row = onlyRow();
    // the accumulator is the only record of a container that failed mid-flight
    expect(row.containerId).toBe("c0ffee123456");
    expect(row.imagePulled).toBe(true);
    expect(row.exitCode).toBe(137);
    expect(row.teardown).toBe("failed");
  });

  test("an interrupted container leaves one row and no error class", async () => {
    // Killed from outside mid-run, which is what a stop command does. This is
    // the path that leaves no row at all when an emit sits after the work.
    await run(
      Effect.gen(function* () {
        const started = yield* Deferred.make<void>();
        const fiber = yield* Effect.forkChild(
          container(
            [STARTED],
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
    // a stop is not a thing that went wrong with a container
    expect(row.errorClass).toBeNull();
    expect(row.errorMessage).toBeNull();
    expect(row.containerId).toBe("c0ffee123456");
  });

  test("a defect is named by the classifier rather than left unread", async () => {
    await run(
      container(
        [],
        Effect.die(
          new Error(
            "Cannot connect to the Docker daemon at unix:///var/run/docker.sock"
          )
        )
      )
    );

    const row = onlyRow();
    expect(row.outcome).toBe("start_failed");
    expect(row.errorClass).toBe("DaemonUnreachable");
    expect(row.errorMessage).toContain("Cannot connect to the Docker daemon");
  });

  test("daemon text reaches the row sanitized", async () => {
    await run(
      container(
        [],
        Effect.die(
          new Error("pull access denied:  Authorization: Bearer abc.def-123")
        )
      )
    );

    const row = onlyRow();
    expect(row.errorClass).toBe("ImageMissing");
    expect(row.errorMessage).toBe(
      "pull access denied: Authorization: [redacted]"
    );
  });

  test("the row survives a Warn floor that silences ordinary log lines", async () => {
    await run(
      Effect.gen(function* () {
        yield* Effect.logInfo("narration that should be dropped");
        return yield* container([STARTED], Effect.succeed(resultOf()));
      }),
      "Warn"
    );

    expect(capture.events).toHaveLength(1);
    // the only line that reached a logger is the wide event itself
    expect(capture.lines).toHaveLength(1);
    expect(readRows()).toHaveLength(1);
  });

  test("the row and the sandbox.run span carry the same trace ids", async () => {
    await run(container([STARTED], Effect.succeed(resultOf())));

    const row = onlyRow();
    expect(typeof row.traceId).toBe("string");
    expect(typeof row.spanId).toBe("string");
  });
});

/** Every series of the sandbox counter after the work, with its attribute keys. */
const counterSeries = () =>
  Effect.gen(function* () {
    const snapshot = yield* Metric.snapshot;
    return snapshot.filter((metric) => metric.id === COUNTER);
  });

const seriesCount = (
  series: readonly {
    readonly attributes: Record<string, string> | undefined;
    readonly state: unknown;
  }[]
) =>
  series.reduce(
    (total, metric) =>
      total + Number((metric.state as { count: number }).count),
    0
  );

describe("the atm_sandbox_runs_total counter", () => {
  test("counts one container per run, tagged only by bounded values", async () => {
    const measured = await Effect.runPromise(
      Effect.gen(function* () {
        const before = seriesCount(yield* counterSeries());
        yield* container([STARTED], Effect.succeed(resultOf())).pipe(
          Effect.exit
        );
        const series = yield* counterSeries();
        return { delta: seriesCount(series) - before, series };
      }).pipe(Effect.provide(testLayer(directory, capture, "Info")))
    );

    expect(measured.delta).toBe(1);
    expect(measured.series.length).toBeGreaterThan(0);
    for (const metric of measured.series) {
      // pins the tag boundary: an unbounded tag added later fails here
      expect(Object.keys(metric.attributes ?? {}).sort()).toEqual([
        "kind",
        "outcome",
        "teardown",
      ]);
    }
  });

  test("a run that never reached teardown ships the 'none' sentinel", async () => {
    const attributes = await Effect.runPromise(
      Effect.gen(function* () {
        yield* container(
          [],
          Effect.fail(
            new ImageMissing({ detail: "no image", image: spec.image })
          )
        ).pipe(Effect.exit);
        const series = yield* counterSeries();
        return series.map((metric) => metric.attributes ?? {});
      }).pipe(Effect.provide(testLayer(directory, capture, "Info")))
    );

    expect(attributes).toContainEqual({
      kind: "docker",
      outcome: "start_failed",
      teardown: "none",
    });
  });
});

describe("observeSandboxProgress", () => {
  test("folds each fact in without dropping the ones already known", async () => {
    const progress = await Effect.runPromise(
      Effect.gen(function* () {
        const cell = yield* makeSandboxProgress;
        yield* observeSandboxProgress(cell, STARTED);
        yield* observeSandboxProgress(cell, { exitCode: 0, oomKilled: false });
        yield* observeSandboxProgress(cell, { teardown: "removed" });
        return yield* Ref.get(cell);
      })
    );

    expect(progress).toEqual({
      containerId: "c0ffee123456",
      exitCode: 0,
      imagePulled: true,
      oomKilled: false,
      peakMemoryBytes: null,
      stderrTail: null,
      teardown: "removed",
    });
  });
});
