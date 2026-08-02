/**
 * The loop itself: the one place every other file in this package is composed
 * into something that runs.
 *
 * Everything below this file answers a question — which task is eligible, who
 * holds the claim, how a turn ends, what the row says. This one decides the
 * order those questions are asked in, and the order is the whole design:
 *
 *   signal → drain commands → read the column → plan → quota → pool → lease →
 *   open → turn → close → ingest → rescan → retry
 *
 * Four properties are load-bearing, and each is here rather than in the file it
 * is about, because each is a statement about the sequence.
 *
 * **Nothing is written before the loop has committed to the run.** A plan reads
 * rows; the quota gate, the pool and the lease each get to refuse over that
 * plan with nothing to undo. Only once all three have said yes does
 * `./open-run` write the session and the run row. The alternative — claim
 * first, discover the provider is drained second — spends a run row and a trip
 * through *review* to say "not now".
 *
 * **The wide event wraps the claim, not the container.** `withRunEvent` goes
 * around everything from the opened run to the close, so `leaseDurationMs`
 * counts the prompt build, the checkout and the close-out as well as the turn —
 * which is what a pool of two is actually starved by. The `phase: "start"` row
 * is written as that wrapper opens, so a process killed mid-run leaves a start
 * with no terminus, and the reconcile below turns that into a countable `lost`
 * rather than into silence.
 *
 * **Reading the run's directory back is a finalizer, not a next step.** The
 * ingest and the artifact rescan hang off the run's own close hook, so a run
 * that was stopped mid-flight still has its timeline, its transcript and its
 * artifacts on the row. A caller that waited for a returned value would skip
 * all of it on exactly the path where it matters most.
 *
 * **Retry covers the failures that leave the task in the column, and only
 * those.** Every ending a run *reaches* moves the task to *review*, failures
 * included — that is the design, and it is the human gate, not an auto-retry
 * queue. Two failures leave the card in *in progress*, where the next sweep
 * thirty seconds later would try again forever: the dispatch that never became
 * a run, and the run that ended but whose move to *review* was refused. Those
 * two, and nothing else, are what the backoff ladder and the park stamp are
 * applied to — and the second one is stamped from inside the close hook, so the
 * run's own row reports the rung it earned.
 */

import type { PgClient } from "@effect/sql-pg";
import {
  AgentSessionRepo,
  CurrentActor,
  ProjectRepo,
  TaskRepo,
  WorkspaceRepo,
} from "@workspace/db";
import {
  Actor,
  type Run,
  type RunTrigger,
  type Task,
  type TaskId,
  type WorkspaceId,
} from "@workspace/domain";
import { entrypointBundlePathOf, hostRunLayout } from "@workspace/harness";
import { sandboxImageFor } from "@workspace/sandbox";
import {
  Cause,
  Context,
  Effect,
  FiberMap,
  Layer,
  Schedule,
  Stream,
} from "effect";
import { FileSystem } from "effect/FileSystem";
import { rescanRunArtifacts } from "./artifacts";
import {
  makeRunCommands,
  RunControl,
  type RunControlInterface,
} from "./commands";
import { orchestratorConfig } from "./config";
import { Dispatch, type Planned } from "./dispatch";
import {
  type DispatchContext,
  lostTerminus,
  type RunTerminus,
} from "./dispatch-context";
import { describeFailure } from "./errors";
import { ingestRunEvents, ingestTurnLedger } from "./ingest";
import { LeaseStore, reconcileLostRuns } from "./lease";
import { openRun, type RunClaim } from "./open-run";
import { freeSlots, type PoolStats, WorkerPool } from "./pool";
import { QuotaGate, quotaGateLayer } from "./quota";
import { stampRetry } from "./retry";
import { type RunClosed, runOpened } from "./run";
import {
  emitLostRun,
  makeRunProgress,
  observeRunProgress,
  type RunEventSettings,
  withRunEvent,
} from "./run-telemetry";
import { closeRun, type TerminalReport } from "./terminal";
import { ingestTranscript } from "./transcript-ingest";
import { type DispatchSignal, dispatchSignals } from "./trigger";
import { runEconomicsOf } from "./turn-rollup";

/** What a boot found the previous process had left behind. */
export interface RecoveryReport {
  /** Lease files whose holder was gone, and which are now free to claim. */
  readonly leasesReclaimed: number;
  /** Run rows still marked live with nobody working on them, closed as `lost`. */
  readonly runsClosed: number;
}

/** The loop, as the process hosting it uses it. Two operations, in this order. */
export interface OrchestratorInterface {
  /**
   * Clears the debris a crashed loop leaves: leases nobody holds, and runs the
   * database still believes are live. Run before anything is dispatched — both
   * kinds of debris lie to a fresh loop, one by making a free task look claimed
   * and the other by making a finished run look unfinished forever.
   *
   * Total: every step is best-effort and logged, because a boot that refuses to
   * start over one stuck row is a factory that stays down.
   */
  readonly recover: Effect.Effect<RecoveryReport>;
  /**
   * Listens, polls, and takes work until it is interrupted. Never returns on
   * its own; the interrupt tears down the in-flight runs, each of which closes
   * its own row on the way out.
   */
  readonly run: Effect.Effect<void>;
}

/** The trigger a sweep dispatches a card under. */
const SWEEP_TRIGGER: RunTrigger = "status_change";

/** How many events a run with no ledger on disk is reported to have produced. */
const NO_EVENTS = 0;

/**
 * Logs a failure this loop is committed to surviving, then continues with a
 * fallback. Named rather than inlined so every deliberate loss in the pass is
 * greppable, and none of them is silent.
 */
const bestEffort =
  <F>(step: string, fallback: F) =>
  <A, E, R>(effect: Effect.Effect<A, E, R>): Effect.Effect<A | F, never, R> =>
    effect.pipe(
      Effect.tapCause((cause) => Effect.logWarning(`loop: ${step}`, cause)),
      Effect.catchCause(() => Effect.succeed<A | F>(fallback))
    );

const make = Effect.gen(function* () {
  const config = yield* orchestratorConfig;
  const actor = yield* CurrentActor;
  const dispatch = yield* Dispatch;
  const gate = yield* QuotaGate;
  const leases = yield* LeaseStore;
  const pool = yield* WorkerPool;
  const projects = yield* ProjectRepo;
  const sessions = yield* AgentSessionRepo;
  const tasks = yield* TaskRepo;
  const workspaces = yield* WorkspaceRepo;

  // The row reports the sandbox that ran the turn. One read of `SANDBOX_MODE`,
  // handed to `./run` and written onto the row, so the implementation that
  // served a turn and the one its row claims cannot be two different answers.
  const settings: RunEventSettings = {
    maxAttempts: config.maxAttempts,
    maxConcurrency: config.maxConcurrency,
    sandboxKind: config.sandboxKind,
  };

  /**
   * The runs this process has a fiber for, keyed by task.
   *
   * By task rather than by run because the key has to exist before the run row
   * does — a stop arriving between the claim and the insert still names a task
   * — and because "one run per task at a time" is the invariant the whole loop
   * is built around. Interrupting an entry is how a container is torn down:
   * there is no kill anywhere in this system, only an interrupted fiber whose
   * finalizers close the run out.
   */
  const running = yield* FiberMap.make<TaskId>();

  /** One task, from the plan to the row that says how it ended. */
  const runPlanned = (planned: Planned, slot: PoolStats) =>
    Effect.gen(function* () {
      const context = yield* openRun(planned.claim);
      const progress = yield* makeRunProgress;

      /** Reads the run's directory back, now that nothing is writing to it. */
      const collect = (closed: RunClosed) =>
        Effect.gen(function* () {
          const { terminus, progress: turn, report } = closed;
          const promptChars = turn.promptChars ?? 0;

          const events = yield* ingestRunEvents({
            context,
            exitCode: terminus.exitCode,
            promptChars,
          }).pipe(bestEffort("event ingest failed", null));

          yield* ingestTranscript({
            context,
            providerSessionId: terminus.providerSessionId,
          }).pipe(bestEffort("transcript ingest failed", null));

          const rollup = yield* ingestTurnLedger({ context }).pipe(
            bestEffort("turn ledger ingest failed", null)
          );

          const artifacts = yield* rescanRunArtifacts({
            context,
            dataRoot: planned.claim.dataRoot,
          }).pipe(bestEffort("artifact rescan failed", null));

          const ladder = yield* stampStalled({
            claim: planned.claim,
            report,
          });

          yield* observeRunProgress(progress, {
            artifactsWritten: artifacts?.indexed ?? 0,
            branch: turn.branch,
            commentFallback: report.fallbackCommented,
            eventsSeen: events?.lines ?? turn.eventsSeen,
            parked: ladder?.kind === "park",
            promptChars: turn.promptChars,
            retryInMs: ladder?.delayMs ?? null,
            terminus:
              rollup === null
                ? terminus
                : ({
                    ...terminus,
                    ...runEconomicsOf({ rollup, terminus }),
                  } as RunTerminus),
          });

          yield* noteQuota(context, terminus);
        });

      return yield* runOpened({
        context,
        dataRoot: planned.claim.dataRoot,
        onClose: collect,
        sandboxKind: config.sandboxKind,
        timeoutMs: config.runTimeoutMs,
      }).pipe(
        withRunEvent({
          dispatch: context,
          poolDepth: slot.depth,
          progress,
          settings,
        }),
        // Caught after the event, so the row still reports the failure, and
        // caught at all because the close hook above has already answered it:
        // the run row, the crash comment, the column and the ladder are all
        // decided by the time this is reached. Letting it reach the claim's own
        // handler would stamp a second rung for one failed attempt. An
        // interrupt is not caught here — a stop is the caller's to see.
        Effect.catch((error) =>
          Effect.as(
            Effect.logError(
              `run ${context.runId} did not complete: ${describeFailure(error).errorMessage}`
            ),
            null
          )
        )
      );
    });

  /**
   * Offers a failed run's error text to the quota gate's reactive floor.
   *
   * The proactive read is the primary gate; this is what covers the window
   * between two polls and the read being switched off entirely. A confident
   * match pauses the provider, so the next sweep defers instead of spending
   * another slot against a wall.
   */
  const noteQuota = (context: DispatchContext, terminus: RunTerminus) =>
    terminus.kind === "failed"
      ? gate
          .noteError({
            message: terminus.errorMessage,
            provider: context.provider,
          })
          .pipe(bestEffort("quota gate refused the error notice", false))
      : Effect.succeed(false);

  /**
   * One rung of the backoff ladder, and what it decided.
   *
   * The decision is returned rather than only written because a run that has a
   * row also has a wide event open over it, and "this attempt failed and the
   * next one is in four minutes" belongs on that row. Best-effort: a stamp the
   * database refused costs a slower ladder, never the close-out it is part of.
   */
  const stampLadder = (claim: RunClaim) =>
    stampRetry({
      attempt: claim.attempt,
      policy: {
        maxAttempts: config.maxAttempts,
        parkMs: config.parkMs,
        retryBaseMs: config.retryBaseMs,
        retryMaxMs: config.retryMaxMs,
      },
      taskId: claim.task.id,
      workspaceId: claim.task.workspaceId,
    }).pipe(bestEffort("the retry stamp was not written", null));

  /** The backoff stamp for a dispatch that never became a run. */
  const stampFailedClaim = (claim: RunClaim, cause: unknown) =>
    Effect.gen(function* () {
      const described = describeFailure(cause);
      yield* Effect.logError(
        `dispatch failed for task ${claim.task.id}: ${described.errorMessage}`
      );
      yield* stampLadder(claim);
    });

  /**
   * The ladder over a run that ended and left its task where it found it.
   *
   * The close moves every ending to *review*, and that move is best-effort like
   * the rest of the terminal path — a card a human dragged elsewhere mid-run
   * refuses the transition, and the run then ends with its task still in the
   * column. That is the one failure a run *reaches* which the next sweep would
   * pick up again thirty seconds later, forever, so it is the one that earns a
   * rung. Everything else the close managed to move is a human's problem now.
   */
  const stampStalled = (input: {
    readonly claim: RunClaim;
    readonly report: TerminalReport;
  }) =>
    input.report.transitioned
      ? Effect.succeed(null)
      : Effect.gen(function* () {
          yield* Effect.logWarning(
            `task ${input.claim.task.id} did not reach review after its run ended — applying the backoff ladder`
          );
          return yield* stampLadder(input.claim);
        });

  /**
   * One task, from the column to a closed run: plan it, ask the gate, take a
   * slot, take the lease, and only then write anything.
   *
   * Total by construction. This is the body of a forked fiber, and a fiber that
   * fails takes its reason nowhere — so every failure is named here, and the
   * only thing that escapes is the interrupt a stop or a shutdown produces.
   */
  const startTask = Effect.fn("Orchestrator.run")(function* (input: {
    readonly task: Task;
    readonly trigger: RunTrigger;
  }) {
    const decision = yield* dispatch
      .plan({ task: input.task, trigger: input.trigger })
      .pipe(
        Effect.catch((error) =>
          Effect.as(stampFailedClaim(claimOf(input.task), error), null)
        )
      );
    if (decision === null) {
      return;
    }
    if (decision.kind === "skipped") {
      yield* Effect.logDebug(
        `task ${decision.taskId} skipped: ${decision.reason}`
      );
      return;
    }

    const held = yield* pool.stats;
    const admission = yield* gate.admit({
      inflight: held.depth,
      provider: decision.provider,
    });
    if (admission.defer) {
      const first = yield* gate.announceOnce({
        provider: decision.provider,
        taskId: input.task.id,
      });
      yield* first
        ? Effect.logWarning(
            `quota: ${decision.provider} deferred — ${admission.reason}`
          )
        : Effect.logDebug(`quota: ${decision.provider} still deferred`);
      return;
    }

    const admitted = yield* pool.admit((slot) =>
      leases
        .withLease({ taskId: input.task.id }, () => runPlanned(decision, slot))
        .pipe(
          Effect.catchTag("Orchestrator.AlreadyLive", () =>
            Effect.as(
              Effect.logDebug(
                `task ${input.task.id} is already claimed — skipping`
              ),
              null
            )
          ),
          Effect.catch((error) =>
            Effect.as(stampFailedClaim(decision.claim, error), null)
          )
        )
    );
    if (admitted.kind === "at_capacity") {
      yield* Effect.logDebug(
        `task ${input.task.id} found the pool full — waiting for the next sweep`
      );
    }
  });

  /** The claim a task would have had, for the failure path that has no plan. */
  const claimOf = (task: Task): RunClaim => ({
    attempt: 1,
    dataRoot: config.dataRoot,
    defaultProvider: config.defaultProvider,
    loopInstance: leases.instanceId,
    project: null,
    queueWaitMs: 0,
    spanId: null,
    task,
    traceId: null,
    traceparent: null,
    trigger: SWEEP_TRIGGER,
  });

  /**
   * Forks a run and remembers it, so a stop command has something to interrupt.
   *
   * `onlyIfMissing` is the in-process half of "one run per task": the lease
   * answers it durably and across processes, and this answers it for the notify
   * and the poll that arrive in the same second, without touching a disk.
   */
  const forkRun = (input: {
    readonly task: Task;
    readonly trigger: RunTrigger;
  }) =>
    startTask(input).pipe(
      Effect.catchCause((cause) =>
        Cause.hasInterruptsOnly(cause)
          ? Effect.void
          : Effect.logError(`run on task ${input.task.id} died`, cause)
      ),
      FiberMap.run(running, input.task.id, { onlyIfMissing: true }),
      Effect.asVoid
    );

  /**
   * The loop's own environment, captured once so the two operations that leave
   * this package can carry it.
   *
   * A run command arrives from a database row and is acted on by a consumer
   * that holds no context of its own; starting a run from one needs every
   * repository, the harness and the filesystem. Capturing here rather than
   * widening {@link RunControlInterface} keeps that seam a pair of plain
   * effects — and this is the only place in the loop that has the services in
   * hand at the moment the record is built.
   */
  const services = yield* Effect.context<
    | Dispatch
    | PgClient.PgClient
    | Effect.Services<ReturnType<typeof startTask>>
    | LeaseStore
    | QuotaGate
    | WorkerPool
  >();

  /**
   * Container lifecycle as the command consumer needs it, implemented where the
   * fibers actually live. Declared in `./commands` and provided here: that
   * module decides whether something should be stopped or started, and holds
   * none of the fibers that make it happen.
   */
  const control: RunControlInterface = {
    dispatch: (request) =>
      Effect.gen(function* () {
        const task = yield* tasks.byId({
          id: request.taskId,
          workspaceId: request.workspaceId,
        });
        yield* forkRun({ task, trigger: request.trigger });
      }).pipe(Effect.provideContext(services)),
    stop: (request) =>
      Effect.gen(function* () {
        const held = yield* FiberMap.has(running, request.taskId);
        if (held) {
          // Interrupting is the teardown: the run's own finalizers close the
          // row, release the lease and emit its terminus row.
          yield* FiberMap.remove(running, request.taskId);
        }
        return held;
      }),
  };

  const commands = yield* Effect.provideService(
    makeRunCommands,
    RunControl,
    RunControl.of(control)
  );

  /**
   * One pass over one workspace: act on what was asked, then take what fits.
   *
   * Commands come first because a stop frees a slot the queue below is about to
   * measure, and a rerun on a task the sweep is also looking at is one fiber
   * either way — `onlyIfMissing` settles which.
   */
  const sweep = Effect.fn("Orchestrator.sweep")(function* (
    workspaceId: WorkspaceId
  ) {
    yield* commands
      .drain({ workspaceId })
      .pipe(bestEffort("the command queue could not be drained", []));

    const stats = yield* pool.stats;
    const free = freeSlots(stats);
    if (free === 0) {
      return;
    }

    const ready = yield* dispatch
      .queue({ limit: free, workspaceId })
      .pipe(bestEffort("the column could not be read", []));

    for (const task of ready) {
      yield* forkRun({ task, trigger: SWEEP_TRIGGER });
    }
  });

  /** Every workspace this database holds. One, while this is single-operator. */
  const allWorkspaces = workspaces
    .list()
    .pipe(bestEffort("the workspace list could not be read", []));

  const pass = (signal: DispatchSignal) =>
    Effect.gen(function* () {
      const found = yield* allWorkspaces;
      for (const workspace of found) {
        // A notice names the workspace whose board moved, and nothing else: the
        // sweep reads the column in rank order whichever source woke it.
        if (
          signal.notice === null ||
          signal.notice.workspaceId === workspace.id
        ) {
          yield* sweep(workspace.id);
        }
      }
    }).pipe(Effect.annotateLogs({ source: signal.source }));

  /**
   * A run the database still believed was live, rebuilt far enough to be closed
   * the way a run that died in front of the loop would be.
   *
   * Three reads rather than a second terminal path, because the alternative is
   * a crash comment, a session ending and a move to *review* written twice from
   * two places — and two implementations of "how a run ends" is how they come
   * to disagree.
   */
  const contextOfLostRun = (input: {
    readonly run: Run;
    readonly workspaceId: WorkspaceId;
  }) =>
    Effect.gen(function* () {
      const task = yield* tasks.byId({
        id: input.run.taskId,
        workspaceId: input.workspaceId,
      });
      const session = yield* sessions.byId({
        id: input.run.agentSessionId,
        workspaceId: input.workspaceId,
      });
      const project =
        task.projectId === null
          ? null
          : yield* projects.byId({
              id: task.projectId,
              workspaceId: input.workspaceId,
            });
      return {
        actor: Actor.cases.orchestrator.make({
          loopInstance: loopInstance(),
          runId: input.run.id,
        }),
        attempt: input.run.attempt,
        image: sandboxImageFor(task.sandboxImage),
        layout: hostRunLayout({
          dataRoot: config.dataRoot,
          runId: input.run.id,
        }),
        project,
        provider: input.run.provider,
        // The wait this run really had is on the row nobody wrote; a number
        // invented at reconcile time would be averaged with the real ones.
        queueWaitMs: 0,
        repoUrl: task.repoUrl ?? project?.repoUrl ?? null,
        runId: input.run.id,
        session:
          session.providerSessionId === null
            ? { mode: "fresh", selected: "latest", session }
            : {
                mode: "resumed",
                providerSessionId: session.providerSessionId,
                selected: "latest",
                session,
              },
        spanId: null,
        task,
        traceId: input.run.traceId,
        traceparent: null,
        trigger: input.run.trigger,
      } satisfies DispatchContext;
    });

  /** This loop, as the audit log names it. */
  const loopInstance = () =>
    actor.kind === "orchestrator" ? actor.loopInstance : leases.instanceId;

  const recover = Effect.gen(function* () {
    const reclaimed = yield* leases.reclaimStale.pipe(
      bestEffort("stale leases could not be reclaimed", [])
    );

    let runsClosed = 0;
    for (const workspace of yield* allWorkspaces) {
      const lost = yield* reconcileLostRuns({
        dataRoot: config.dataRoot,
        workspaceId: workspace.id,
      }).pipe(bestEffort("lost runs could not be reconciled", []));

      for (const closed of lost) {
        runsClosed += 1;
        yield* closeLostRun({ ...closed, workspaceId: workspace.id });
      }
    }

    return {
      leasesReclaimed: reclaimed.length,
      runsClosed,
    } satisfies RecoveryReport;
  }).pipe(Effect.withSpan("Orchestrator.recover"));

  /**
   * Finishes what a killed process started: the crash comment, the failed
   * session, the move to *review*, and the terminus row that turns a start with
   * no ending into a countable `lost` run.
   */
  const closeLostRun = (input: {
    readonly run: Run;
    readonly terminus: RunTerminus;
    readonly workspaceId: WorkspaceId;
  }) =>
    Effect.gen(function* () {
      const context = yield* contextOfLostRun(input);
      const terminus =
        input.terminus.kind === "lost"
          ? input.terminus
          : lostTerminus({
              eventsSeen: NO_EVENTS,
              exitCode: input.run.exitCode,
              finalText: "",
              providerSessionId: null,
            });
      yield* Effect.logWarning(
        `run ${input.run.id} on task ${context.task.id} was lost — closing it out`
      );
      // The same terminal path a run that died in front of the loop takes: the
      // run row is already closed by the reconcile, which this treats as the
      // ordinary agreement it is, and the comment, the session and the move to
      // *review* are what is actually left to do.
      yield* closeRun({
        branch: null,
        commentPosted: false,
        context,
        terminus,
      });
      yield* emitLostRun({
        context,
        eventsSeen: terminus.eventsSeen,
        settings,
        terminus,
      });
    }).pipe(bestEffort("a lost run could not be closed out", undefined));

  /**
   * Every reason to sweep, consumed until the fiber is interrupted.
   *
   * The stream reconnects its own listener; what this catches is the stream
   * itself ending — a `LISTEN` connection that could not be acquired at all. A
   * loop that let that kill it would be a factory that stops taking work
   * because a socket blinked, so the failure is loud and the whole stream is
   * rebuilt one poll interval later. There is no attempt count at which giving
   * up is the right answer.
   */
  const pump = Stream.runForEach(
    dispatchSignals({ pollIntervalMs: config.pollIntervalMs }),
    (signal) => pass(signal).pipe(bestEffort("a sweep failed", undefined))
  ).pipe(
    Effect.tapCause((cause) =>
      Effect.logError("dispatch signals stopped — restarting", cause)
    ),
    Effect.ignoreCause,
    Effect.repeat(Schedule.spaced(config.pollIntervalMs)),
    Effect.asVoid
  );

  /**
   * What this process is about to run turns on, said once at boot.
   *
   * The container path has one prerequisite the loop cannot supply for itself:
   * the entrypoint is bundled onto the host rather than baked into the image,
   * so a checkout that has never run `bun run entrypoint:build` starts every
   * container against a mount source that is not there. That failure is
   * `Sandbox.MountSourceMissing` per run and perfectly clear once read — this
   * says it once, at boot, before any task has been spent on it.
   */
  const announceSandbox = Effect.gen(function* () {
    if (config.sandboxKind === "local") {
      yield* Effect.logWarning(
        "SANDBOX_MODE is local: every turn runs as a host process with no isolation, and its row says so"
      );
      return;
    }
    const fs = yield* FileSystem;
    const bundle = entrypointBundlePathOf(config.dataRoot);
    const present = yield* fs
      .exists(bundle)
      .pipe(Effect.orElseSucceed(() => false));
    yield* present
      ? Effect.logInfo(`turns run in containers, entrypoint ${bundle}`)
      : Effect.logWarning(
          `the turn entrypoint is not bundled at ${bundle}: every container will refuse to start until \`bun run entrypoint:build\` has run`
        );
  });

  const run = Effect.gen(function* () {
    yield* announceSandbox;
    yield* Effect.logInfo(
      `loop listening on ${config.maxConcurrency} slots, polling every ${config.pollIntervalMs}ms`
    );
    yield* pump;
  });

  // Both operations run against the environment this layer was built over,
  // rather than asking for it again at the call site. That is what keeps the
  // package's surface two plain effects: a host process provides a database, a
  // sandbox and a ledger once, to the layer, and never learns the names of the
  // five services the loop assembled out of them.
  return Orchestrator.of({
    recover: recover.pipe(Effect.provideContext(services)),
    run: run.pipe(Effect.provideContext(services)),
  });
});

/**
 * The loop as one service, so the process hosting it composes a layer and calls
 * two methods. Everything else this package exports is something this file
 * already asked.
 */
export class Orchestrator extends Context.Service<
  Orchestrator,
  OrchestratorInterface
>()("@workspace/orchestrator/Orchestrator") {
  /**
   * The loop over its own four services, which stay inside.
   *
   * A caller holding `Dispatch` could claim a task with no lease, and a caller
   * holding `WorkerPool` would be a second cap on one box. Both are the failures
   * the ordering in this file exists to prevent, so the layer hides what it
   * builds and the host provides only what those four are made of: a database,
   * a sandbox, a harness, a ledger, and the actor every write is attributed to.
   */
  static readonly layer = Layer.effect(Orchestrator, make).pipe(
    Layer.provide(
      Layer.mergeAll(
        Dispatch.layer,
        LeaseStore.layer,
        quotaGateLayer,
        WorkerPool.layer
      )
    )
  );
}
