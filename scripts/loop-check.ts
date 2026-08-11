#!/usr/bin/env bun

/**
 * Proves the two claims the loop stands on: a task moved into *in progress* is
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
 * Three modes, and the difference is where the turn happens and who answers it.
 *
 * `bun run loop:check` runs a stub provider as a host process
 * (`SANDBOX_MODE=local`), free and in seconds. It proves the loop, claim by
 * claim: a task moved into *in progress* is claimed, run and landed in review;
 * the run row closes as `done`; the normalized events reach `run_events`; a run
 * that posted no message has its last message appended as one; the file the run
 * wrote is in the artifact index; the transcript written inside the run's agent
 * home is in the run directory once that home has been torn down, and no
 * credential came out with it; the run leaves exactly one `atm.run` start row
 * and one terminus row; and a loop killed with the run in flight is recovered
 * on restart with the killed run recorded as `lost` and the checkout it
 * stranded swept off the disk.
 *
 * `bun run loop:check --docker` makes every claim on that list except the kill
 * and the recovery, with the turn served by a real container on
 * `atm.local/base:latest` — plus the three in `./loop-check-container` that
 * only a container can answer. Still free: the model call is the one thing
 * stubbed, by the entrypoint in `./loop-check-turn`, which this bundles to the
 * path the orchestrator mounts from.
 *
 * `bun run loop:check --live` is the real provider, spending real subscription
 * allowance on a real turn. It proves the one thing a stub cannot: that a
 * dispatched task reaches an actual model and comes back.
 *
 * **What no mode here proves.** That a PR is opened. That a real vendor's
 * transcript parses — the stub writes one in the vendor's own layout and
 * dialect, so the rescue and the read are proved, but the dialect itself is
 * asked of fixtures in `packages/harness`. That the quota gate defers, which
 * needs a drained subscription. And, in `--docker`, that a vendor CLI boots
 * inside the image: that is the one substitution the contained mode makes, and
 * `bun run harness:check --live` is where it is asked.
 *
 * **The kill half always runs on a host process.** Where the turn was running
 * changes nothing about the lease, the orphaned run row or the terminus the
 * restart writes — and a killed parent leaves its container behind to run out
 * its own cap, which is debris a check should not create. So `--docker` skips
 * it and the default mode proves it.
 *
 * Everything this writes is scoped to its own data root
 * (`${DATA_ROOT}/loop-check`) so a real loop's leases and run directories are
 * never touched. The rows it creates are deleted on the way out; the audit
 * trail behind them stays, as it does everywhere.
 */

import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import process from "node:process";

/** The flag that makes this script the process meant to be killed. */
const CRASH_CHILD = "--crash-child";

/** The flag that runs the turn in a real container. */
const DOCKER = "--docker";

/** The flag that spends money. */
const LIVE = "--live";

/**
 * Whether this invocation serves its turn from a container. Read here rather
 * than below because it decides `SANDBOX_MODE`, which the loop reads through
 * `Config` while its layer is being built.
 */
const CONTAINED = process.argv.includes(DOCKER);

/**
 * Whether a real provider answers this invocation. Read alongside
 * {@link CONTAINED} because a handful of claims can only be made against one
 * kind of answer: a stub says a known sentence, and a model says whatever it
 * decided to say.
 */
const ANSWERED_LIVE = process.argv.includes(LIVE);

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
// The crash child never sets this flag, so it always takes the host path — see
// the note above about the debris a killed parent's container would leave.
process.env.SANDBOX_MODE = CONTAINED ? "docker" : "local";
process.env.ORCHESTRATOR_MAX_CONCURRENCY = "1";
process.env.ORCHESTRATOR_POLL_INTERVAL_MS = "1000";
process.env.ORCHESTRATOR_LEASE_HEARTBEAT_MS = "1000";
// The host's system-owned login for each provider, pointed at this check's own
// root rather than the operator's. Created here because nothing on the run path
// creates one: an auto-made empty home boots a container that reports an auth
// error nobody can tell from an expired token, so the loop refuses instead.
//
// Not in `--live`, where the operator's own home is the whole point: a real
// provider asked to log in from a directory this check invented has no login to
// find, and answers "please run /login" — which is indistinguishable from the
// credential problem this check exists to catch. Only the stub is content with
// a fabricated home, so only the stub gets one.
if (!process.argv.includes(LIVE)) {
  for (const [variable, segment] of [
    ["ATM_AGENT_HOME_DIR_CLAUDE", "claude"],
    ["ATM_AGENT_HOME_DIR_CODEX", "codex"],
  ] as const) {
    const home = join(CHECK_ROOT, "agent-home", segment);
    mkdirSync(home, { recursive: true });
    process.env[variable] = home;
  }
}

import { BunRuntime, BunServices } from "@effect/platform-bun";
import {
  ArtifactRepo,
  ChatMessageRepo,
  ChatThreadRepo,
  CurrentActor,
  RunEventRepo,
  RunRepo,
  storeLayer,
  TaskMessageRepo,
  TaskRepo,
  withActor,
} from "@workspace/db";
import {
  Actor,
  type ChatThread,
  type Run,
  type SessionProvider,
  type Task,
  type TaskId,
  type ThreadId,
  UserId,
  type WorkspaceId,
} from "@workspace/domain";
import {
  makeProviderRegistry,
  ProviderRegistry,
  providerTable,
  type RunOptions,
} from "@workspace/harness";
import { Orchestrator } from "@workspace/orchestrator";
import {
  DEFAULT_SANDBOX_IMAGE,
  ScopeHistory,
  sandboxLayer,
  taskArtifactsDirOf,
  workspaceLayer,
} from "@workspace/sandbox";
import { EventLog, telemetryLayer } from "@workspace/telemetry";
import { type Duration, Effect, Layer, Schedule, Schema, Tracer } from "effect";
import {
  CheckFailed,
  check,
  checkoutLeftBehind,
  runDirEvidence,
  runRows,
} from "./loop-check-claims";
import { containedClaims, prepareContainer } from "./loop-check-container";
import {
  ARTIFACT_FILE,
  forbiddenProvider,
  hangingProvider,
  STUB_FINAL_TEXT,
  STUB_TRANSCRIPT_TEXT,
  stubProvider,
} from "./loop-check-stub";
import { ensureWorkspace } from "./store/workspace";

/** Names the ledger file and the `application_name` Postgres reports. */
const SERVICE = "loop-check";

/** Which loop instance the orchestrator actor claims to be. */
const LOOP_INSTANCE = "loop-check";

/**
 * How long the happy path may take before the check gives up on it.
 *
 * A stubbed turn answers in milliseconds, so anything past a few seconds there
 * means the loop is stuck rather than busy. A real one reads files, calls tools
 * and thinks, and minutes of that is the work happening rather than a fault —
 * giving up at ninety seconds would report a healthy run as a failure and kill
 * the turn that was about to finish.
 */
const REVIEW_TIMEOUT = process.argv.includes("--live")
  ? "15 minutes"
  : "90 seconds";

/** How long the child gets to claim its task and go quiet. */
const LIVE_TIMEOUT = "60 seconds";

/** How long the teardown gets to snapshot the shared scopes and rescan the folder. */
const INDEX_TIMEOUT = "30 seconds";

/** How often the database is asked whether the loop has got there yet. */
const POLL = "250 millis";

/**
 * The rows a stubbed run must leave in `run_events`: the session init, the
 * assistant message and the terminus. Fewer means the stream was not ingested.
 */
const MIN_TIMELINE_ROWS = 3;

/** The account this check files its tasks as. Nothing logs in as it. */
const CHECK_USER = UserId.make(`${SERVICE}-human`);

/**
 * The trace an inbound request would have arrived under, minted here so it
 * demonstrably starts outside everything the loop does. Fresh per invocation,
 * so a run from an earlier check cannot satisfy the claim.
 */
const TRACE_ID_BYTES = 16;
const SPAN_ID_BYTES = 8;
const REQUEST_TRACE_ID = randomBytes(TRACE_ID_BYTES).toString("hex");
const REQUEST_SPAN_ID = randomBytes(SPAN_ID_BYTES).toString("hex");

/** The child was killed and the parent never saw its run go live. */
class ChildNeverStarted extends Schema.TaggedErrorClass<ChildNeverStarted>()(
  "LoopCheck.ChildNeverStarted",
  { detail: Schema.String }
) {}

/** Which of the four harnesses this invocation runs on. */
type RegistryMode = "contained" | "hang" | "live" | "stub";

/**
 * The task's artifacts folder as the host sees it, which is where the host's
 * own stub writes. The contained stub writes into the same folder through the
 * mount, and says so with the container's spelling of the path.
 */
const hostArtifactsDir = (options: RunOptions) =>
  options.taskId === null
    ? null
    : taskArtifactsDirOf({ dataRoot: CHECK_ROOT, taskId: options.taskId });

/**
 * Which harness table this invocation runs on.
 *
 * `contained` is the important one: the turn happens inside the container, so
 * the host's registry must be unable to serve it. A provider that dies is how
 * a run quietly served on the host shows up as a defect rather than as a check
 * that passed for the wrong reason.
 */
const registryLayer = (mode: RegistryMode) => {
  if (mode === "live") {
    return Layer.succeed(ProviderRegistry, makeProviderRegistry(providerTable));
  }
  const make = (id: SessionProvider) => {
    if (mode === "contained") {
      return forbiddenProvider(id);
    }
    return mode === "hang"
      ? hangingProvider(id)
      : stubProvider({ artifactsDir: hostArtifactsDir, id });
  };
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
const appLayer = (registry: RegistryMode) =>
  Orchestrator.layer.pipe(
    Layer.provideMerge(
      Layer.mergeAll(
        CurrentActor.layer(
          Actor.cases.orchestrator.make({ loopInstance: LOOP_INSTANCE })
        ),
        registryLayer(registry),
        sandboxLayer,
        ScopeHistory.layer,
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

/** The turns this check's conversation produced, newest first. */
const turnsFor = (input: { threadId: ThreadId; workspaceId: WorkspaceId }) =>
  Effect.flatMap(RunRepo, (runs) => runs.listByThread(input));

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

/**
 * Reads the task's artifact index back until the rescan has landed, or gives up.
 *
 * The board does not wait for the index: a run reports its outcome and moves the
 * task, and only then does teardown snapshot the shared scopes and rescan the
 * folder. Reading once the moment the task turns up in `review` therefore asks
 * the question before the answer exists, and a single read would report a
 * healthy loop as a broken one. The claim being checked is that the rescan
 * happens, not that it beats the status change.
 */
const awaitIndexed = (input: {
  readonly taskId: TaskId;
  readonly workspaceId: WorkspaceId;
}) =>
  Effect.gen(function* () {
    const artifacts = yield* ArtifactRepo;
    const read = artifacts.listByTask(input);
    return yield* read.pipe(
      Effect.filterOrFail(
        (indexed) => indexed.length > 0,
        () => "not yet"
      ),
      Effect.retry(Schedule.spaced(POLL)),
      Effect.timeout(INDEX_TIMEOUT),
      // Giving up reads once more rather than failing here, so an index that
      // stayed empty is reported by the claim below — with what it holds — and
      // not as a timeout that says nothing about the artifact.
      Effect.catch(() => read)
    );
  });

/**
 * The task this check dispatches: no project, no repo, so no clone and no
 * network.
 *
 * Filed under a span whose parent came from outside this process, which is
 * exactly the shape a gateway handler has when a request arrives carrying a
 * `traceparent`: the write knows nothing about the trace, it simply happens
 * inside it. That is what makes the run row's `trace_id` below evidence of a
 * trace crossing the database rather than of this process tracing itself.
 */
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
  }).pipe(
    Effect.withSpan("POST /tasks"),
    Effect.withParentSpan(
      Tracer.externalSpan({
        spanId: REQUEST_SPAN_ID,
        traceId: REQUEST_TRACE_ID,
      })
    )
  );

/**
 * A conversation with one thing said in it and nothing said back.
 *
 * No Telegram chat id: a thread opened here is the same row a dashboard would
 * open, which is the point — one conversation, reachable from either window.
 */
const openThread = (workspaceId: WorkspaceId) =>
  Effect.gen(function* () {
    const threads = yield* ChatThreadRepo;
    const messages = yield* ChatMessageRepo;
    const thread = yield* threads.open({
      provider: "claude",
      title: "loop:check — a message becomes a turn",
      userId: CHECK_USER,
      workspaceId,
    });
    yield* messages.append({
      body: "What is left on the board this week?",
      intakeKind: "api",
      role: "user",
      threadId: thread.id,
      workspaceId,
    });
    return thread;
  });

/**
 * The chat half: a message in a conversation is claimed, run and answered by
 * the same loop, through the same lease, pool, quota gate and run row a task
 * gets.
 *
 * The claims are deliberately the ones that are *not* about chat: a run row
 * with a role on it, a lease, two `atm.run` rows. If a manager turn needed any
 * of them written specially, this is where that would show.
 */
const chatPath = (input: {
  readonly thread: ChatThread;
  readonly workspaceId: WorkspaceId;
}) =>
  Effect.gen(function* () {
    const ledger = yield* EventLog;
    const messages = yield* ChatMessageRepo;
    const { thread, workspaceId } = input;

    const answered = yield* turnsFor({ threadId: thread.id, workspaceId }).pipe(
      Effect.filterOrFail(
        (turns) =>
          turns[0]?.outcome !== undefined && turns[0]?.outcome !== null,
        () => "not yet"
      ),
      Effect.retry(Schedule.spaced(POLL)),
      Effect.timeoutOrElse({
        duration: REVIEW_TIMEOUT,
        orElse: () =>
          Effect.fail(
            new CheckFailed({
              detail: "no turn on the thread ever closed",
              step: "a message in a conversation becomes a run",
            })
          ),
      })
    );

    const turn = answered[0] as Run;
    yield* check({
      detail: `the turn closed as ${turn.outcome}, role ${turn.role}, thread ${turn.threadId}`,
      ok:
        turn.outcome === "done" &&
        turn.role === "manager" &&
        turn.taskId === null &&
        turn.threadId === thread.id,
      step: "a message in a conversation becomes a manager run with no task",
    });

    const said = yield* messages.listForThread({
      threadId: thread.id,
      workspaceId,
    });
    const answer = said.find((message) => message.role === "manager");
    yield* check({
      detail: `the thread holds ${said.length} messages; the answer names run ${answer?.runId ?? "nothing"}`,
      ok: answer !== undefined && answer.runId === turn.id,
      step: "the answer is a row in the conversation, carrying the run that produced it",
    });

    const rows = runRows({ path: ledger.path, runId: turn.id });
    yield* check({
      detail: `found ${rows.filter((row) => row.phase === "start").length} start rows and ${rows.filter((row) => row.phase === "end").length} end rows, lane ${rows[0]?.lane}`,
      ok:
        rows.filter((row) => row.phase === "start").length === 1 &&
        rows.filter((row) => row.phase === "end").length === 1 &&
        rows.every((row) => row.role === "manager" && row.lane === "chat"),
      step: "a chat turn leaves the same two atm.run rows a worker run does, in the chat lane",
    });
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
    const messages = yield* TaskMessageRepo;
    const runEvents = yield* RunEventRepo;

    const task = yield* fileTask({
      title: `loop:check — dispatched and finished${CONTAINED ? " in a container" : ""}`,
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

    // The whole point of minting the id at the edge: the request wrote a task
    // and went away, another process picked the row up on its own clock, and
    // the run it opened is still that request's. Nothing was passed between
    // them but the column on the task.
    yield* check({
      detail: `the request traced ${REQUEST_TRACE_ID}, the run row traces ${run.traceId ?? "nothing"}`,
      ok: run.traceId === REQUEST_TRACE_ID,
      step: "the run row carries the trace the inbound request minted",
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

    const thread = yield* messages.forTask({ taskId: task.id, workspaceId });
    yield* check({
      detail: `the thread holds ${thread.length} messages, kinds ${thread
        .map((message) => message.kind)
        .join(", ")}`,
      // A stub ends on a sentence this file knows, so the body is checked
      // against it and the fallback is proved to carry the run's own last
      // message rather than any text at all. A model ends on whatever it
      // decided to say, so live can only ask that the message arrived and is
      // not empty — pinning a phrase there would be a check on the model's
      // prose, which is not what this claim is about.
      ok: thread.some(
        (message) =>
          message.kind === "fallback" &&
          (ANSWERED_LIVE
            ? message.body.trim().length > 0
            : message.body.includes(STUB_FINAL_TEXT))
      ),
      step: "a run that posted no message had its last message appended as one",
    });

    const indexed = yield* awaitIndexed({ taskId: task.id, workspaceId });
    yield* check({
      detail: `the index holds ${indexed.length} artifacts`,
      // The stub writes one file this script named, so its path is what is
      // looked for. A model writes whatever the brief led it to write, and the
      // claim is that the rescan found it — not that it chose a filename.
      ok: ANSWERED_LIVE
        ? indexed.length > 0
        : indexed.some((entry) => entry.path.endsWith(ARTIFACT_FILE)),
      step: "the file the run wrote is in the artifact index",
    });

    const left = runDirEvidence({ dataRoot: CHECK_ROOT, runId: run.id });
    yield* check({
      detail: `${left.transcriptPath} holds ${left.transcript?.length ?? 0} characters`,
      // Same distinction: the stub's transcript carries a sentence this file
      // knows, while a real one carries the turn that happened. What is being
      // proved either way is that this run's own conversation was found in a
      // shared tree every run on the host writes into, and copied where a
      // re-ingest weeks later can still read it.
      ok: ANSWERED_LIVE
        ? (left.transcript?.length ?? 0) > 0
        : left.transcript?.includes(STUB_TRANSCRIPT_TEXT) === true,
      step: "the run's own transcript is copied out of the shared agent home into its run directory",
    });
    yield* check({
      detail: `the run directory holds ${left.entries.length} files: ${left.entries.join(", ")}`,
      ok: left.credentials.length === 0,
      step: "nothing of the operator's login came out of the shared home with it",
    });

    const rows = runRows({ path: ledger.path, runId: run.id });
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
    // The ledger and the row agree, because both read the same span: the loop
    // adopted the request's context as its parent rather than copying an id
    // onto one of them.
    yield* check({
      detail: `the terminus row traces ${end[0]?.traceId ?? "nothing"}`,
      ok: end[0]?.traceId === REQUEST_TRACE_ID,
      step: "the run's wide event lands in the request's trace too",
    });

    if (CONTAINED) {
      // The handle a post-mortem is read through. Written when the container is
      // created rather than when it exits, which is the only ordering that
      // leaves a name on the runs worth investigating — one that would not
      // start, one that was killed, one still going.
      yield* check({
        detail: `the run row names container ${run.containerId ?? "nothing at all"}`,
        ok: run.containerId?.startsWith(`atm-${run.id}-`) === true,
        step: "the run row carries the name of the container that served it",
      });
      yield* containedClaims({
        dataRoot: CHECK_ROOT,
        ledgerPath: ledger.path,
        rows,
        runId: run.id,
      });
    }

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

    const started = runRows({ path: ledger.path, runId: live.id });
    yield* check({
      detail: `found ${started.length} rows for the killed run`,
      ok:
        started.some((row) => row.phase === "start") &&
        !started.some((row) => row.phase === "end"),
      step: "the killed run left a start row and no terminus",
    });

    // The run reached `running`, which is the harness answering, which is after
    // the checkout was made — so this is a directory that certainly exists and
    // certainly has nobody left committed to removing it.
    const stranded = checkoutLeftBehind({
      dataRoot: CHECK_ROOT,
      runId: live.id,
    });
    yield* check({
      detail: `${stranded.path} is ${stranded.present ? "still there" : "already gone"}`,
      ok: stranded.present,
      step: "the killed run's checkout outlives the process that promised to remove it",
    });

    const recovered = yield* orchestrator.recover;
    yield* Effect.logInfo(
      `recovered — ${recovered.leasesReclaimed} leases reclaimed, ${recovered.runsClosed} runs closed as lost, ${recovered.swept.checkouts} checkouts swept`
    );
    yield* check({
      detail: `the reconcile closed ${recovered.runsClosed} runs`,
      ok: recovered.runsClosed >= 1,
      step: "a restart closes the run nobody is working on",
    });

    // After the row claim and not before, because that is the order the recover
    // itself works in: the checkout is only strandable once the run's row has
    // stopped saying it is live.
    const afterSweep = checkoutLeftBehind({
      dataRoot: CHECK_ROOT,
      runId: live.id,
    });
    yield* check({
      detail: `${afterSweep.path} is ${afterSweep.present ? "still there" : "gone"}`,
      ok: !afterSweep.present,
      step: "a restart sweeps the checkout the killed run stranded",
    });

    const closed = yield* runsFor({ taskId: task.id, workspaceId });
    yield* check({
      detail: `the killed run is recorded as ${closed[0]?.outcome}`,
      ok: closed[0]?.outcome === "lost" || closed[0]?.outcome === "interrupted",
      step: "the killed run is lost in the ledger, never green and never absent",
    });

    const after = runRows({ path: ledger.path, runId: live.id });
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

/**
 * Archives the conversation this check opened. Archived rather than deleted:
 * the runs and the audit rows behind it point at the thread, which is exactly
 * why the API has no delete for one either.
 */
const closeThread = (input: {
  readonly threadId: ThreadId;
  readonly workspaceId: WorkspaceId;
}) =>
  Effect.flatMap(ChatThreadRepo, (threads) =>
    threads.archive({ id: input.threadId, workspaceId: input.workspaceId })
  ).pipe(Effect.ignoreCause);

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
  // Refused rather than resolved. The contained mode's provider is inside the
  // bundle it mounts, so `--live` beside it would name a harness on the host
  // that nothing ever calls — an invocation that says it spent allowance and
  // did not.
  if (live && CONTAINED) {
    return yield* Effect.fail(
      new CheckFailed({
        detail: `${LIVE} and ${DOCKER} name two different providers; run them one at a time`,
        step: "the flags name one mode",
      })
    );
  }
  const ledger = yield* EventLog;
  yield* Effect.logInfo(
    `${SERVICE}: ${live ? "LIVE — this spends real subscription allowance" : "stubbed provider, no money spent"}, ${
      CONTAINED
        ? `turns run in containers on ${DEFAULT_SANDBOX_IMAGE}`
        : "turns run as host processes"
    }`
  );
  yield* Effect.logInfo(`data root ${CHECK_ROOT}, ledger ${ledger.path}`);

  if (CONTAINED) {
    yield* prepareContainer(CHECK_ROOT);
  }

  const { workspace } = yield* ensureWorkspace();
  const filed: TaskId[] = [];

  // Opened before the loop starts, so the sweep that answers the task finds
  // this waiting too: the two lanes are what stop either from waiting on the
  // other, and running them together is the only way to see that.
  const thread = yield* openThread(workspace.id);

  // Both halves inside one scope, because the loop is forked into it: the chat
  // turn is claimed by the same running loop that just answered the task, which
  // is the only way to see the two lanes not waiting on each other.
  const happy = yield* Effect.scoped(
    Effect.gen(function* () {
      const dispatched = yield* happyPath(workspace.id);
      yield* chatPath({ thread, workspaceId: workspace.id });
      return dispatched;
    })
  );
  filed.push(happy);

  // Skipped in the contained mode, for the reason the module note gives: a
  // parent killed mid-run leaves its container behind to run out its own cap.
  // The crash half always runs on the stub otherwise — killing a live turn
  // mid-flight would spend allowance on a conversation nobody reads.
  if (!CONTAINED) {
    const crashed = yield* crashPath(workspace.id);
    filed.push(crashed);
  }

  yield* cleanUp({ taskIds: filed, workspaceId: workspace.id });
  yield* closeThread({ threadId: thread.id, workspaceId: workspace.id });
  // The ledger sits under this check's own data root, so the viewer has to be
  // pointed at it — printing the exact command is what makes the two rows this
  // check just wrote readable by the operator rather than only by the check.
  yield* Effect.logInfo(
    `every claim held; read the runs back with EVENT_LOG_DIR=${join(CHECK_ROOT, "events")} bun run logs`
  );
});

const childTaskId = process.argv[process.argv.indexOf(CRASH_CHILD) + 1];

/** Which harness this invocation hands the loop. The flags do not combine. */
const registryMode = (): RegistryMode => {
  if (process.argv.includes(LIVE)) {
    return "live";
  }
  return CONTAINED ? "contained" : "stub";
};

BunRuntime.runMain(
  process.argv.includes(CRASH_CHILD) && childTaskId !== undefined
    ? crashChild(childTaskId).pipe(Effect.provide(appLayer("hang")))
    : loopCheck.pipe(Effect.provide(appLayer(registryMode())))
);
