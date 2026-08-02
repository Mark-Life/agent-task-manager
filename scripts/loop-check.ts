#!/usr/bin/env bun

/**
 * Proves the two claims Phase 4 exits on: a task moved into *in progress* is
 * picked up, run and landed in *review* without anybody touching anything, and
 * a loop killed mid-run recovers on restart with the killed run showing up as
 * `lost` — never as a green row and never as nothing.
 *
 * It is a script rather than a test because both claims are about a real
 * database, a real lease file on disk, a real `LISTEN/NOTIFY` trigger and a
 * real process being killed. The parts provable without any of that — the
 * backoff ladder, the prompt, the event mapping, the wide event's shape on each
 * exit path — are unit tests in `packages/orchestrator/src`.
 *
 * Two modes, and the difference is what runs the turn.
 *
 *   bun run loop:check          A stub provider and the local sandbox. Free,
 *                               and seconds. Proves everything about the loop:
 *                               the trigger, the plan, the pool, the lease, the
 *                               run rows, the timeline in `run_events`, the
 *                               fallback comment, the artifact index, the two
 *                               `atm.run` rows, the kill and the recovery.
 *
 *   bun run loop:check --live   The real provider, which spends real
 *                               subscription allowance on a real turn. This is
 *                               the one that costs money. It proves the one
 *                               thing a stub cannot: that a dispatched task
 *                               reaches an actual model and comes back.
 *
 * **What the default mode does not prove.** It does not prove that a run is
 * isolated — nothing in this system does yet, because the turn is served as a
 * host process whichever mode `SANDBOX_MODE` names; `bun run sandbox:check` is
 * the check that containers work, and the loop does not use them. It does not
 * prove that a model can be reached, that a PR is opened, or that the
 * transcript ingest reads a real provider's file — the stub writes none. And it
 * does not prove the quota gate defers, which needs a drained subscription.
 *
 * Everything this writes is scoped to its own data root
 * (`${DATA_ROOT}/loop-check`) so a real loop's leases and run directories are
 * never touched. The rows it creates are deleted on the way out; the audit
 * trail behind them stays, as it does everywhere.
 */

import { spawn } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import process from "node:process";

/**
 * Every setting the loop reads, pinned before a layer is built.
 *
 * Written onto the process environment rather than passed through a
 * `ConfigProvider`, because the child process below has to see exactly the same
 * ones — and because this is an entrypoint, which is the one place a script
 * owns its own environment.
 */
const CHECK_SEGMENT = "loop-check";
const CONFIGURED_ROOT = process.env.DATA_ROOT?.trim() || ".data";
// Idempotent, because the child below inherits this environment and runs the
// same three lines: a root that already ends in the segment is this check's
// own, and nesting it again would give the child a second ledger the parent
// never reads.
const CHECK_ROOT = CONFIGURED_ROOT.endsWith(CHECK_SEGMENT)
  ? CONFIGURED_ROOT
  : join(CONFIGURED_ROOT, CHECK_SEGMENT);
process.env.DATA_ROOT = CHECK_ROOT;
process.env.EVENT_LOG_DIR = join(CHECK_ROOT, "events");
process.env.SANDBOX_MODE = "local";
process.env.ORCHESTRATOR_MAX_CONCURRENCY = "1";
process.env.ORCHESTRATOR_POLL_INTERVAL_MS = "1000";
process.env.ORCHESTRATOR_LEASE_HEARTBEAT_MS = "1000";

import { BunRuntime, BunServices } from "@effect/platform-bun";
import {
  ArtifactRepo,
  CommentRepo,
  CurrentActor,
  RunEventRepo,
  RunRepo,
  storeLayer,
  TaskRepo,
  withActor,
} from "@workspace/db";
import {
  Actor,
  type Run,
  type SessionProvider,
  type Task,
  type TaskId,
  UserId,
  type WorkspaceId,
} from "@workspace/domain";
import {
  type AgentEvent,
  type AgentProvider,
  makeProviderRegistry,
  ProviderRegistry,
  providerTable,
  type RunOptions,
} from "@workspace/harness";
import {
  Orchestrator,
  RUN_EVENT_MARKER,
  RunEvent,
} from "@workspace/orchestrator";
import {
  sandboxLayer,
  taskArtifactsDirOf,
  workspaceLayer,
} from "@workspace/sandbox";
import { EventLog, telemetryLayer } from "@workspace/telemetry";
import { type Duration, Effect, Layer, Schedule, Schema, Stream } from "effect";
import { ensureWorkspace } from "./store/workspace";

/** Names the ledger file and the `application_name` Postgres reports. */
const SERVICE = "loop-check";

/** Which loop instance the orchestrator actor claims to be. */
const LOOP_INSTANCE = "loop-check";

/** How long the happy path may take before the check gives up on it. */
const REVIEW_TIMEOUT = "90 seconds";

/** How long the child gets to claim its task and go quiet. */
const LIVE_TIMEOUT = "60 seconds";

/** How often the database is asked whether the loop has got there yet. */
const POLL = "250 millis";

/** The flag that makes this script the process meant to be killed. */
const CRASH_CHILD = "--crash-child";

/** The flag that spends money. */
const LIVE = "--live";

/**
 * The rows a stubbed run must leave in `run_events`: the session init, the
 * assistant message and the terminus. Fewer means the stream was not ingested.
 */
const MIN_TIMELINE_ROWS = 3;

/** What the stub writes into the task's artifacts directory. */
const ARTIFACT_FILE = "stub-run-output.md";

/** The stub's answer, which becomes the run's fallback comment. */
const STUB_FINAL_TEXT =
  "Stubbed turn: nothing was asked of a model, and this text is what the fallback comment carries.";

/** The account this check files its tasks as. Nothing logs in as it. */
const CHECK_USER = UserId.make(`${SERVICE}-human`);

/** One thing the loop was supposed to do and did not. */
class CheckFailed extends Schema.TaggedErrorClass<CheckFailed>()(
  "LoopCheck.Failed",
  { detail: Schema.String, step: Schema.String }
) {}

/** The child was killed and the parent never saw its run go live. */
class ChildNeverStarted extends Schema.TaggedErrorClass<ChildNeverStarted>()(
  "LoopCheck.ChildNeverStarted",
  { detail: Schema.String }
) {}

/**
 * Asserts one claim, naming what was expected when it does not hold. Failing as
 * a value rather than throwing is what makes the whole check one effect that
 * stops at the first broken claim and exits non-zero.
 */
const check = (options: {
  readonly detail: string;
  readonly ok: boolean;
  readonly step: string;
}) =>
  options.ok
    ? Effect.logInfo(`ok    ${options.step}`)
    : Effect.fail(
        new CheckFailed({ detail: options.detail, step: options.step })
      );

/**
 * A provider that answers without a model.
 *
 * It is a whole `AgentProvider` rather than a patched real one because the
 * registry hands the loop a provider and nothing else: everything downstream —
 * the event file, `run_events`, the terminus, the fallback comment — is driven
 * by the stream, so a scripted stream exercises the entire lifecycle at no cost.
 *
 * The one thing it does beyond talking is write a file into the task's
 * artifacts directory, which is what makes the rescan's claim checkable: an
 * index built from a directory a run really wrote to.
 */
const stubProvider = (id: SessionProvider): AgentProvider => ({
  capabilities: {
    cost: false,
    hooks: false,
    rateLimitSignal: false,
    reasoning: false,
    resume: true,
    subagents: false,
  },
  defaultEffort: null,
  displayName: `${id} (stub)`,
  efforts: [],
  id,
  models: [],
  run: (options: RunOptions) =>
    Stream.unwrap(
      Effect.sync(() => {
        const providerSessionId = `stub-${options.runId ?? "run"}`;
        if (options.taskId !== null) {
          const directory = taskArtifactsDirOf({
            dataRoot: CHECK_ROOT,
            taskId: options.taskId,
          });
          mkdirSync(directory, { recursive: true });
          writeFileSync(
            join(directory, ARTIFACT_FILE),
            `# Stub run\n\nWritten by the ${id} stub for run ${options.runId}.\n`
          );
        }
        const events: readonly AgentEvent[] = [
          {
            kind: "session_init",
            model: "stub-1",
            provider: id,
            providerSessionId,
          },
          { kind: "assistant_text", text: STUB_FINAL_TEXT },
          {
            costUsd: null,
            durationMs: 1,
            errorClass: null,
            errorMessage: null,
            kind: "result",
            outcome: "done",
            providerSessionId,
            text: STUB_FINAL_TEXT,
            totalTokens: 128,
            turns: 1,
          },
        ];
        return Stream.fromIterable(events);
      })
    ),
});

/**
 * A provider that starts a turn and then says nothing forever, so the process
 * running it can be killed with a run genuinely in flight. Without the
 * `session_init` the run row would never reach `running`, and the crash would
 * be indistinguishable from a loop that never picked the task up.
 */
const hangingProvider = (id: SessionProvider): AgentProvider => ({
  ...stubProvider(id),
  run: (options: RunOptions) =>
    Stream.concat(
      Stream.fromIterable<AgentEvent>([
        {
          kind: "session_init",
          model: "stub-1",
          provider: id,
          providerSessionId: `stub-${options.runId ?? "run"}`,
        },
      ]),
      Stream.never
    ),
});

/** Which harness table this invocation runs on. */
const registryLayer = (mode: "live" | "hang" | "stub") => {
  if (mode === "live") {
    return Layer.succeed(ProviderRegistry, makeProviderRegistry(providerTable));
  }
  const make = mode === "hang" ? hangingProvider : stubProvider;
  return Layer.succeed(
    ProviderRegistry,
    makeProviderRegistry({ claude: make("claude"), codex: make("codex") })
  );
};

/**
 * The whole process, as one layer, in the order `apps/loop` builds it — with
 * the harness swapped and everything merged out, because the check reads the
 * rows the loop wrote.
 */
const appLayer = (mode: "live" | "hang" | "stub") =>
  Orchestrator.layer.pipe(
    Layer.provideMerge(
      Layer.mergeAll(
        CurrentActor.layer(
          Actor.cases.orchestrator.make({ loopInstance: LOOP_INSTANCE })
        ),
        registryLayer(mode),
        sandboxLayer,
        storeLayer({ applicationName: SERVICE }),
        workspaceLayer
      )
    ),
    Layer.provideMerge(
      Layer.mergeAll(
        telemetryLayer({ serviceName: SERVICE }),
        EventLog.layer({ serviceName: SERVICE })
      ).pipe(Layer.provideMerge(BunServices.layer))
    )
  );

/** The rows this check wrote for one task, newest run first. */
const runsFor = (input: { taskId: TaskId; workspaceId: WorkspaceId }) =>
  Effect.flatMap(RunRepo, (runs) => runs.listByTask(input));

/** Reads the task back until it lands where it is expected, or gives up. */
const awaitStatus = (input: {
  readonly status: Task["status"];
  readonly taskId: TaskId;
  readonly timeout: Duration.Input;
  readonly workspaceId: WorkspaceId;
}) =>
  Effect.gen(function* () {
    const tasks = yield* TaskRepo;
    return yield* tasks
      .byId({ id: input.taskId, workspaceId: input.workspaceId })
      .pipe(
        Effect.filterOrFail(
          (task) => task.status === input.status,
          () => "not yet"
        ),
        Effect.retry(Schedule.spaced(POLL)),
        Effect.timeoutOrElse({
          duration: input.timeout,
          orElse: () =>
            Effect.fail(
              new CheckFailed({
                detail: `the task never reached ${input.status}`,
                step: `the loop lands the task in ${input.status}`,
              })
            ),
        })
      );
  });

/** Waits until a run on this task is actually live, which is what makes a kill mid-flight. */
const awaitLiveRun = (input: {
  readonly taskId: TaskId;
  readonly workspaceId: WorkspaceId;
}) =>
  Effect.gen(function* () {
    const runs = yield* RunRepo;
    return yield* runs.liveForTask(input).pipe(
      Effect.filterOrFail(
        (run): run is Run => run !== null && run.status === "running",
        () => "not yet"
      ),
      Effect.retry(Schedule.spaced(POLL)),
      Effect.timeoutOrElse({
        duration: LIVE_TIMEOUT,
        orElse: () =>
          Effect.fail(
            new ChildNeverStarted({
              detail: "no run reached `running` before the timeout",
            })
          ),
      })
    );
  });

/** One decoded row of the ledger this check wrote to. */
type LedgerRow = typeof RunEvent.rowSchema.Type;

const decodeRow = Schema.decodeUnknownOption(RunEvent.rowSchema);

/**
 * The `atm.run` rows for one run, read off the JSONL the way `bun run logs`
 * reads it. Reading the file rather than an in-memory sink is the point: the
 * ledger is what survives the process, and the killed run's start row was
 * written by a process that no longer exists.
 */
const ledgerRows = (input: { path: string; runId: string }): LedgerRow[] => {
  if (!existsSync(input.path)) {
    return [];
  }
  const rows: LedgerRow[] = [];
  for (const line of readFileSync(input.path, "utf8").split("\n")) {
    if (line.trim().length === 0 || !line.includes(RUN_EVENT_MARKER)) {
      continue;
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      continue;
    }
    const decoded = decodeRow(parsed);
    if (decoded._tag === "Some" && decoded.value.runId === input.runId) {
      rows.push(decoded.value);
    }
  }
  return rows;
};

/** The task this check dispatches: no project, no repo, so no clone and no network. */
const fileTask = (input: { title: string; workspaceId: WorkspaceId }) =>
  Effect.gen(function* () {
    const tasks = yield* TaskRepo;
    return yield* withActor(Actor.cases.human.make({ userId: CHECK_USER }))(
      tasks.create({
        brief:
          "Filed by loop:check. Nothing about this task needs a repository or a network.",
        status: "in_progress",
        title: input.title,
        workspaceId: input.workspaceId,
      })
    );
  });

/**
 * The half of the check that is meant to die.
 *
 * A child process rather than an interrupted fiber, because the claim is about
 * a loop that was killed rather than one that was asked to stop: an interrupt
 * runs finalizers, and finalizers are exactly what a `SIGKILL` skips. What has
 * to be left behind is a run row still marked live, a lease file with a dead
 * pid on it, and a start row in the ledger with no terminus — which is the
 * debris the parent then proves it can clear.
 */
const crashChild = (taskId: string) =>
  Effect.gen(function* () {
    const orchestrator = yield* Orchestrator;
    yield* Effect.logInfo(
      `child: taking task ${taskId} and waiting to be killed`
    );
    yield* orchestrator.run;
  });

/** The dispatched-and-finished half, on a stub. */
const happyPath = (workspaceId: WorkspaceId) =>
  Effect.gen(function* () {
    const orchestrator = yield* Orchestrator;
    const ledger = yield* EventLog;
    const comments = yield* CommentRepo;
    const artifacts = yield* ArtifactRepo;
    const runEvents = yield* RunEventRepo;

    const task = yield* fileTask({
      title: "loop:check — dispatched and finished",
      workspaceId,
    });
    yield* Effect.logInfo(`filed task ${task.id} in in_progress`);

    // Forked into this scope, so the loop stops when the check does, and every
    // in-flight run closes itself out on the way.
    yield* Effect.forkScoped(orchestrator.run);

    const reviewed = yield* awaitStatus({
      status: "review",
      taskId: task.id,
      timeout: REVIEW_TIMEOUT,
      workspaceId,
    });
    yield* check({
      detail: `the task is in ${reviewed.status}`,
      ok: reviewed.status === "review",
      step: "a task in in_progress is picked up, run, and landed in review",
    });

    const [run] = yield* runsFor({ taskId: task.id, workspaceId });
    if (run === undefined) {
      return yield* Effect.fail(
        new CheckFailed({
          detail: "the task reached review with no run row behind it",
          step: "the run is recorded",
        })
      );
    }

    yield* check({
      detail: `the run closed as ${run.outcome} in ${run.status}`,
      ok: run.outcome === "done" && run.status === "finished",
      step: "the run row closed as done",
    });

    const timeline = yield* runEvents.listByRun({
      runId: run.id,
      workspaceId,
    });
    yield* check({
      detail: `the run left ${timeline.length} rows in run_events`,
      ok: timeline.length >= MIN_TIMELINE_ROWS,
      step: "the normalized events reached run_events",
    });

    const thread = yield* comments.forTask({ taskId: task.id, workspaceId });
    yield* check({
      detail: `the thread holds ${thread.length} comments, kinds ${thread
        .map((comment) => comment.kind)
        .join(", ")}`,
      ok: thread.some((comment) => comment.kind === "fallback"),
      step: "a run that posted no comment had its last message appended as one",
    });

    const indexed = yield* artifacts.listByTask({
      taskId: task.id,
      workspaceId,
    });
    yield* check({
      detail: `the index holds ${indexed.length} artifacts`,
      ok: indexed.some((entry) => entry.path.endsWith(ARTIFACT_FILE)),
      step: "the file the run wrote is in the artifact index",
    });

    const rows = ledgerRows({ path: ledger.path, runId: run.id });
    const start = rows.filter((row) => row.phase === "start");
    const end = rows.filter((row) => row.phase === "end");
    yield* check({
      detail: `found ${start.length} start rows and ${end.length} end rows`,
      ok: start.length === 1 && end.length === 1,
      step: "the run left exactly one atm.run start row and one terminus row",
    });
    yield* check({
      detail: `the terminus row says ${end[0]?.outcome}`,
      ok: end[0]?.outcome === "done",
      step: "the terminus row reports the run as done",
    });

    return task.id;
  });

/** The killed-and-recovered half. */
const crashPath = (workspaceId: WorkspaceId) =>
  Effect.gen(function* () {
    const orchestrator = yield* Orchestrator;
    const ledger = yield* EventLog;
    const tasks = yield* TaskRepo;

    const task = yield* fileTask({
      title: "loop:check — killed mid-run",
      workspaceId,
    });
    yield* Effect.logInfo(`filed task ${task.id}; starting a loop to kill`);

    const child = yield* Effect.acquireRelease(
      Effect.sync(() =>
        spawn(process.execPath, [import.meta.filename, CRASH_CHILD, task.id], {
          env: process.env,
          stdio: "inherit",
        })
      ),
      (spawned) => Effect.sync(() => spawned.kill("SIGKILL"))
    );

    const live = yield* awaitLiveRun({ taskId: task.id, workspaceId });
    yield* Effect.logInfo(`run ${live.id} is live in pid ${child.pid}`);

    // SIGKILL, not SIGTERM: the whole claim is about a loop that had no chance
    // to close anything, so nothing may run on the way out.
    yield* Effect.sync(() => child.kill("SIGKILL"));
    yield* Effect.callback<void>((resume) => {
      child.on("exit", () => resume(Effect.void));
    });
    yield* Effect.logInfo("the loop was killed with the run in flight");

    const orphaned = yield* runsFor({ taskId: task.id, workspaceId });
    yield* check({
      detail: `the killed run is ${orphaned[0]?.status}`,
      ok: orphaned[0]?.outcome === null,
      step: "the killed run is left open in the database, as a crash leaves it",
    });

    const started = ledgerRows({ path: ledger.path, runId: live.id });
    yield* check({
      detail: `found ${started.length} rows for the killed run`,
      ok:
        started.some((row) => row.phase === "start") &&
        !started.some((row) => row.phase === "end"),
      step: "the killed run left a start row and no terminus",
    });

    const recovered = yield* orchestrator.recover;
    yield* Effect.logInfo(
      `recovered — ${recovered.leasesReclaimed} leases reclaimed, ${recovered.runsClosed} runs closed as lost`
    );
    yield* check({
      detail: `the reconcile closed ${recovered.runsClosed} runs`,
      ok: recovered.runsClosed >= 1,
      step: "a restart closes the run nobody is working on",
    });

    const closed = yield* runsFor({ taskId: task.id, workspaceId });
    yield* check({
      detail: `the killed run is recorded as ${closed[0]?.outcome}`,
      ok: closed[0]?.outcome === "lost" || closed[0]?.outcome === "interrupted",
      step: "the killed run is lost in the ledger, never green and never absent",
    });

    const after = ledgerRows({ path: ledger.path, runId: live.id });
    const terminus = after.find((row) => row.phase === "end");
    yield* check({
      detail: `the terminus row says ${terminus?.outcome ?? "nothing at all"}`,
      ok: terminus?.outcome === "lost",
      step: "the recovery wrote the terminus row the killed loop could not",
    });

    const moved = yield* tasks.byId({ id: task.id, workspaceId });
    yield* check({
      detail: `the task is in ${moved.status}`,
      ok: moved.status === "review",
      step: "the lost run's task is in review, where a human decides",
    });

    return task.id;
  }).pipe(Effect.scoped);

/** Deletes the tasks this check filed. Everything hanging off them cascades. */
const cleanUp = (input: {
  readonly taskIds: readonly TaskId[];
  readonly workspaceId: WorkspaceId;
}) =>
  Effect.gen(function* () {
    const tasks = yield* TaskRepo;
    yield* Effect.forEach(input.taskIds, (id) =>
      withActor(Actor.cases.human.make({ userId: CHECK_USER }))(
        tasks.delete({ id, workspaceId: input.workspaceId })
      )
    );
  }).pipe(Effect.ignoreCause);

const loopCheck = Effect.gen(function* () {
  const live = process.argv.includes(LIVE);
  const ledger = yield* EventLog;
  yield* Effect.logInfo(
    `${SERVICE}: ${live ? "LIVE — this spends real subscription allowance" : "stubbed provider, local sandbox, no money spent"}`
  );
  yield* Effect.logInfo(`data root ${CHECK_ROOT}, ledger ${ledger.path}`);

  const { workspace } = yield* ensureWorkspace();
  const filed: TaskId[] = [];

  const happy = yield* happyPath(workspace.id).pipe(Effect.scoped);
  filed.push(happy);

  // The crash half always runs on the stub: killing a live turn mid-flight
  // would spend allowance on a conversation nobody reads.
  const crashed = yield* crashPath(workspace.id);
  filed.push(crashed);

  yield* cleanUp({ taskIds: filed, workspaceId: workspace.id });
  // The ledger sits under this check's own data root, so the viewer has to be
  // pointed at it — printing the exact command is what makes the two rows this
  // check just wrote readable by the operator rather than only by the check.
  yield* Effect.logInfo(
    `every claim held; read both runs back with EVENT_LOG_DIR=${join(CHECK_ROOT, "events")} bun run logs`
  );
});

const childTaskId = process.argv[process.argv.indexOf(CRASH_CHILD) + 1];

BunRuntime.runMain(
  process.argv.includes(CRASH_CHILD) && childTaskId !== undefined
    ? crashChild(childTaskId).pipe(Effect.provide(appLayer("hang")))
    : loopCheck.pipe(
        Effect.provide(appLayer(process.argv.includes(LIVE) ? "live" : "stub"))
      )
);
