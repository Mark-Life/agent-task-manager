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
  ChatThreadRepo,
  CurrentActor,
  ProjectRepo,
  RunRepo,
  TaskRepo,
  WorkspaceRepo,
} from "@workspace/db";
import {
  Actor,
  parseTraceparent,
  type Run,
  type RunId,
  type RunSubject,
  type RunTrigger,
  type SessionProvider,
  type WorkspaceId,
} from "@workspace/domain";
import {
  EXECUTOR_KEY_ENV_VAR,
  EXECUTOR_URL_ENV_VAR,
  entrypointBundlePathOf,
  hostRunLayout,
  readExecutorMcp,
} from "@workspace/harness";
import {
  AGENT_TOKEN_ENV_VAR,
  GH_TOKEN_ENV_VAR,
  githubTokenEnv,
  orphansOf,
  readGithubToken,
  Sandbox,
  sandboxImageFor,
} from "@workspace/sandbox";
import {
  Cause,
  Context,
  Effect,
  FiberMap,
  Layer,
  Redacted,
  Schedule,
  Stream,
  Tracer,
} from "effect";
import { FileSystem } from "effect/FileSystem";
import { tokenTtlFor } from "./agent-token";
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
import { freeSlots, type PoolLane, type PoolStats, WorkerPool } from "./pool";
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
import {
  managerAttachment,
  type RunAttachment,
  subjectKeyOf,
  subjectOfAttachment,
  subjectOfRow,
  workerAttachment,
} from "./subject";
import { closeRun, type TerminalReport } from "./terminal";
import { ingestTranscript } from "./transcript-ingest";
import { type DispatchSignal, dispatchSignals } from "./trigger";
import { runEconomicsOf } from "./turn-rollup";

/** What a boot found the previous process had left behind. */
export interface RecoveryReport {
  /** Containers left by a process that was killed before its teardown could run. */
  readonly containersReaped: number;
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

/**
 * The trigger a chat turn dispatches under. `status_change` too, because a
 * message arriving is the same kind of cause a card entering a column is: the
 * state of the thing changed, and the loop noticed.
 */
const CHAT_TRIGGER: RunTrigger = "status_change";

/**
 * Runs a dispatch under the span that asked for it, where the row that caused
 * it carried one.
 *
 * Adopting the caller's span as this fiber's parent, rather than copying a
 * trace id onto the run row, is what makes the join hold all the way down: the
 * claim reads its ids off the ambient span, the run row is written from those
 * ids, the container's `traceparent` is built from them, and the wide event
 * carries them. One adoption here puts the lot inside the request's trace, and
 * a header that does not parse simply leaves the loop tracing itself, which is
 * what it did before anybody asked over HTTP.
 */
const underCaller = <A, E, R>(
  traceparent: string | null,
  effect: Effect.Effect<A, E, R>
) => {
  const caller = parseTraceparent(traceparent);
  return caller === null
    ? effect
    : Effect.withParentSpan(effect, Tracer.externalSpan(caller));
};

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

/**
 * The environment every turn is handed, on top of its own ids and agent home.
 *
 * **Named one variable at a time, never forwarded wholesale.** A turn gets
 * exactly what the design says it needs — the Executor endpoint and its key,
 * which is the connector layer every task that touches Notion, Jira or a
 * calendar runs on — and nothing else this process happens to have been started
 * with. The list *is* the allow-list, which is what makes a credential an
 * operator exported for some other tool absent from a container by default
 * rather than by a filter somebody remembered to write.
 *
 * **The host's observability export is not on the list and never will be.** The
 * OTLP endpoint and the bearer token in `OTEL_EXPORTER_OTLP_HEADERS` belong to
 * the operator: a container writes its wide events to a file on the run mount
 * and this loop forwards them. `@workspace/sandbox` drops the whole `OTEL_*`
 * family on the way in, and this list never offering one is the other half of
 * the same rule.
 *
 * **The key travels as a value nobody can read off the host.** `docker run` is
 * given `--env=NAME` and reads the value out of the CLI's own environment, so
 * the argv every `ps` on the box shows carries names alone — and the only thing
 * said about the key in a log or on a span is that it was set.
 *
 * Both halves or neither, through {@link readExecutorMcp}: a url with no key is
 * an endpoint that answers 401 to every tool call. An install that configured
 * neither runs with no connector tools, which is a smaller agent and not a
 * broken one, so an unreadable configuration is an empty environment rather
 * than a loop that refuses to boot.
 */
export const turnEnvironment = Effect.gen(function* () {
  const executor = yield* readExecutorMcp.pipe(
    Effect.orElseSucceed(() => null)
  );
  const github = yield* readGithubToken;
  const env: Readonly<Record<string, string>> = {
    ...(executor === null
      ? {}
      : {
          [EXECUTOR_KEY_ENV_VAR]: Redacted.value(executor.key),
          [EXECUTOR_URL_ENV_VAR]: executor.url,
        }),
    // The same token the host's git was given, so `gh` in the container is
    // logged in and the checkout's credential helper has something to read.
    // Without it an agent can commit and never push, which surfaces at the end
    // of a run that already did the work.
    ...githubTokenEnv(github),
  };
  return env;
});

const make = Effect.gen(function* () {
  const config = yield* orchestratorConfig;
  const actor = yield* CurrentActor;
  const dispatch = yield* Dispatch;
  const gate = yield* QuotaGate;
  const threads = yield* ChatThreadRepo;
  const leases = yield* LeaseStore;
  const pool = yield* WorkerPool;
  const projects = yield* ProjectRepo;
  const runs = yield* RunRepo;
  const sandbox = yield* Sandbox;
  const sessions = yield* AgentSessionRepo;
  const tasks = yield* TaskRepo;
  const workspaces = yield* WorkspaceRepo;

  // Read once, here, and handed to every run: the same reasoning as
  // `SANDBOX_MODE` below — one read is one answer, and a per-run read is where
  // two turns in the same process come to disagree about what they were given.
  const turnEnv = yield* turnEnvironment;

  // The row reports the sandbox that ran the turn. One read of `SANDBOX_MODE`,
  // handed to `./run` and written onto the row, so the implementation that
  // served a turn and the one its row claims cannot be two different answers.
  const settings: RunEventSettings = {
    maxAttempts: config.maxAttempts,
    sandboxKind: config.sandboxKind,
  };

  /**
   * The runs this process has a fiber for, keyed by subject.
   *
   * By subject rather than by run because the key has to exist before the run
   * row does — a stop arriving between the claim and the insert still names a
   * task or a thread — and because "one run per task, one turn per thread" is
   * the invariant the whole loop is built around. Interrupting an entry is how
   * a container is torn down: there is no kill anywhere in this system, only an
   * interrupted fiber whose finalizers close the run out.
   */
  const running = yield* FiberMap.make<string>();

  /** Which lane a run holds a slot in. The one thing the role decides here. */
  const laneOf = (attached: RunAttachment): PoolLane =>
    attached.role === "manager" ? "chat" : "work";

  /**
   * The deadline for one turn. A person is waiting on a manager turn, so it is
   * capped in minutes; a worker run is a whole piece of work and is capped in
   * hours.
   */
  const timeoutFor = (attached: RunAttachment) =>
    attached.role === "manager" ? config.chatTimeoutMs : config.runTimeoutMs;

  /** The host's shared login directory for one provider. Read once, at boot. */
  const agentHomeDirOf = (provider: SessionProvider) =>
    config.agentHomeDirs[provider];

  /** The row a subject names, read back so a stage that needs the whole entity has it. */
  const attach = Effect.fnUntraced(function* (input: {
    readonly subject: RunSubject;
    readonly workspaceId: WorkspaceId;
  }) {
    const { subject, workspaceId } = input;
    return subject.kind === "task"
      ? workerAttachment(yield* tasks.byId({ id: subject.id, workspaceId }))
      : managerAttachment(yield* threads.byId({ id: subject.id, workspaceId }));
  });

  /**
   * What a run row was attached to. A row whose columns name neither is one the
   * database can no longer produce, and rebuilding a context from a guess would
   * close somebody else's work out.
   */
  const subjectOfLostRun = (row: Run) => {
    const subject = subjectOfRow(row);
    return subject === null
      ? Effect.die(new Error(`run ${row.id} names neither a task nor a thread`))
      : Effect.succeed(subject);
  };

  /** One piece of work, from the plan to the row that says how it ended. */
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
            agentHomeDir: agentHomeDirOf(context.provider),
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
        agentHomeDir: agentHomeDirOf(context.provider),
        context,
        dataRoot: planned.claim.dataRoot,
        // Without this a contained turn starts with no Executor credentials at
        // all, and the connector layer is simply absent inside the sandbox.
        env: turnEnv,
        gatewayUrl: config.gatewayUrl,
        onClose: collect,
        sandboxKind: config.sandboxKind,
        skillsDir: config.skillsDir,
        timeoutMs: timeoutFor(context.attached),
        tokenTtlMs: tokenTtlFor({
          configured: config.agentTokenTtlMs,
          timeoutMs: timeoutFor(context.attached),
        }),
      }).pipe(
        withRunEvent({
          dispatch: context,
          lane: slot.lane,
          laneCapacity: slot.capacity,
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
    claim.attached.role === "worker"
      ? stampRetry({
          attempt: claim.attempt,
          policy: {
            maxAttempts: config.maxAttempts,
            parkMs: config.parkMs,
            retryBaseMs: config.retryBaseMs,
            retryMaxMs: config.retryMaxMs,
          },
          taskId: claim.attached.task.id,
          workspaceId: claim.attached.task.workspaceId,
        }).pipe(bestEffort("the retry stamp was not written", null))
      : // A conversation has no column to be stuck in. The next thing the
        // person says is what dispatches the next turn, and a backoff stamped
        // on a thread would be a chat that ignores them for four minutes.
        Effect.succeed(null);

  /** The backoff stamp for a dispatch that never became a run. */
  const stampFailedClaim = (claim: RunClaim, cause: unknown) =>
    Effect.gen(function* () {
      const described = describeFailure(cause);
      yield* Effect.logError(
        `dispatch failed for ${subjectKeyOf(subjectOfAttachment(claim.attached))}: ${described.errorMessage}`
      );
      yield* stampLadder(claim);
    });

  /**
   * The ladder over a run that ended and left its task where it found it.
   *
   * The close moves every worker ending to *review*, and that move is
   * best-effort like the rest of the terminal path — a card a human dragged
   * elsewhere mid-run refuses the transition, and the run then ends with its
   * task still in the column. That is the one failure a run *reaches* which the
   * next sweep would pick up again thirty seconds later, forever, so it is the
   * one that earns a rung. Everything else the close managed to move is a
   * human's problem now, and a manager run reports `transitioned` because it
   * has no card that could be left behind.
   */
  const stampStalled = (input: {
    readonly claim: RunClaim;
    readonly report: TerminalReport;
  }) =>
    input.report.transitioned
      ? Effect.succeed(null)
      : Effect.gen(function* () {
          yield* Effect.logWarning(
            `${subjectKeyOf(subjectOfAttachment(input.claim.attached))} did not reach review after its run ended — applying the backoff ladder`
          );
          return yield* stampLadder(input.claim);
        });

  /**
   * One piece of work, from the queue to a closed run: plan it, ask the gate,
   * take a slot in its lane, take the lease, and only then write anything.
   *
   * Identical for both roles and in the same order: a chat turn and a worker
   * run are one runtime, and this is where that is true rather than claimed.
   * The lane is the one branch, and it is a property of what the run is
   * attached to rather than a decision made here.
   *
   * Total by construction. This is the body of a forked fiber, and a fiber that
   * fails takes its reason nowhere — so every failure is named here, and the
   * only thing that escapes is the interrupt a stop or a shutdown produces.
   */
  const startWork = Effect.fn("Orchestrator.run")(function* (input: {
    readonly attached: RunAttachment;
    readonly trigger: RunTrigger;
  }) {
    const subject = subjectOfAttachment(input.attached);
    const subjectKey = subjectKeyOf(subject);
    const lane = laneOf(input.attached);

    const decision = yield* dispatch
      .plan({ attached: input.attached, trigger: input.trigger })
      .pipe(
        Effect.catch((error) =>
          Effect.as(stampFailedClaim(claimOf(input.attached), error), null)
        )
      );
    if (decision === null) {
      return;
    }
    if (decision.kind === "skipped") {
      yield* Effect.logDebug(`${subjectKey} skipped: ${decision.reason}`);
      return;
    }

    // Keyed by provider, not by lane: a drained Claude subscription should
    // defer a chat turn for the same reason it defers a worker run.
    const held = yield* pool.statsOf(lane);
    const admission = yield* gate.admit({
      inflight: held.totalDepth,
      provider: decision.provider,
    });
    if (admission.defer) {
      const first = yield* gate.announceOnce({
        provider: decision.provider,
        subjectKey,
      });
      yield* first
        ? Effect.logWarning(
            `quota: ${decision.provider} deferred — ${admission.reason}`
          )
        : Effect.logDebug(`quota: ${decision.provider} still deferred`);
      return;
    }

    const admitted = yield* pool.admit(lane, (slot) =>
      leases
        .withLease({ subject }, () => runPlanned(decision, slot))
        .pipe(
          Effect.catchTag("Orchestrator.AlreadyLive", () =>
            Effect.as(
              Effect.logDebug(`${subjectKey} is already claimed — skipping`),
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
        `${subjectKey} found the ${lane} lane full — waiting for the next sweep`
      );
    }
  });

  /** The claim this work would have had, for the failure path that has no plan. */
  const claimOf = (attached: RunAttachment): RunClaim => ({
    attached,
    attempt: 1,
    dataRoot: config.dataRoot,
    defaultProvider: config.defaultProvider,
    loopInstance: leases.instanceId,
    project: null,
    queueWaitMs: 0,
    spanId: null,
    traceId: null,
    traceparent: null,
    trigger: SWEEP_TRIGGER,
  });

  /**
   * Forks a run and remembers it, so a stop command has something to interrupt.
   *
   * `onlyIfMissing` is the in-process half of "one run per subject": the lease
   * answers it durably and across processes, and this answers it for the notify
   * and the poll that arrive in the same second, without touching a disk.
   *
   * The command's `traceparent` wins over the row's own, because a rerun asked
   * for now is a newer cause than the move that put the card in the column; a
   * sweep names none and the task's own stamp answers.
   */
  const forkRun = (input: {
    readonly attached: RunAttachment;
    /** The request that asked, where a command carried one of its own. */
    readonly traceparent?: string | null;
    readonly trigger: RunTrigger;
  }) => {
    const subjectKey = subjectKeyOf(subjectOfAttachment(input.attached));
    return underCaller(
      input.traceparent ??
        (input.attached.role === "worker"
          ? input.attached.task.dispatchTraceparent
          : null),
      startWork(input)
    ).pipe(
      Effect.catchCause((cause) =>
        Cause.hasInterruptsOnly(cause)
          ? Effect.void
          : Effect.logError(`run on ${subjectKey} died`, cause)
      ),
      FiberMap.run(running, subjectKey, { onlyIfMissing: true }),
      Effect.asVoid
    );
  };

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
    | Effect.Services<ReturnType<typeof startWork>>
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
        yield* forkRun({
          attached: yield* attach({
            subject: request.subject,
            workspaceId: request.workspaceId,
          }),
          traceparent: request.traceparent,
          trigger: request.trigger,
        });
      }).pipe(Effect.provideContext(services)),
    stop: (request) =>
      Effect.gen(function* () {
        const key = subjectKeyOf(request.subject);
        const held = yield* FiberMap.has(running, key);
        if (held) {
          // Interrupting is the teardown: the run's own finalizers close the
          // row, release the lease and emit its terminus row.
          yield* FiberMap.remove(running, key);
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

    // Chat first, and it costs nothing to say so: the two lanes have their own
    // slots, so this is an ordering between two independent reads rather than a
    // priority. A person is waiting on one of them.
    yield* takeChat(workspaceId);
    yield* takeWork(workspaceId);
  });

  /** The head of the *in progress* column that fits in the work lane. */
  const takeWork = Effect.fnUntraced(function* (workspaceId: WorkspaceId) {
    const free = freeSlots(yield* pool.statsOf("work"));
    if (free === 0) {
      return;
    }
    const ready = yield* dispatch
      .queue({ limit: free, workspaceId })
      .pipe(bestEffort("the column could not be read", []));

    for (const task of ready) {
      yield* forkRun({
        attached: workerAttachment(task),
        trigger: SWEEP_TRIGGER,
      });
    }
  });

  /**
   * The conversations with something unanswered that fit in the chat lane.
   *
   * The same shape as the column read above and deliberately so: a queue in
   * Postgres, bounded by the lane's free slots, claimed through the same lease
   * and the same `onlyIfMissing` guard. What used to be a `Map` in the bot — and
   * was dropped on every restart — is this query.
   */
  const takeChat = Effect.fnUntraced(function* (workspaceId: WorkspaceId) {
    const free = freeSlots(yield* pool.statsOf("chat"));
    if (free === 0) {
      return;
    }
    const waiting = yield* dispatch
      .chatQueue({ limit: free, workspaceId })
      .pipe(bestEffort("the chat queue could not be read", []));

    for (const thread of waiting) {
      yield* forkRun({
        attached: managerAttachment(thread),
        trigger: CHAT_TRIGGER,
      });
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
      const { workspaceId } = input;
      const attached = yield* attach({
        subject: yield* subjectOfLostRun(input.run),
        workspaceId,
      });
      const session = yield* sessions.byId({
        id: input.run.agentSessionId,
        workspaceId,
      });
      const task = attached.role === "worker" ? attached.task : null;
      const project =
        task === null || task.projectId === null
          ? null
          : yield* projects.byId({ id: task.projectId, workspaceId });
      return {
        actor: Actor.cases.orchestrator.make({
          loopInstance: loopInstance(),
          runId: input.run.id,
        }),
        attached,
        attempt: input.run.attempt,
        image: sandboxImageFor(task?.sandboxImage ?? null),
        layout: hostRunLayout({
          dataRoot: config.dataRoot,
          runId: input.run.id,
        }),
        project,
        provider: input.run.provider,
        // The wait this run really had is on the row nobody wrote; a number
        // invented at reconcile time would be averaged with the real ones.
        queueWaitMs: 0,
        repoUrl: task?.repoUrl ?? project?.repoUrl ?? null,
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
        traceId: input.run.traceId,
        traceparent: null,
        trigger: input.run.trigger,
      } satisfies DispatchContext;
    });

  /**
   * Removes the containers a killed process left behind, and answers with how
   * many.
   *
   * The teardown of an ordinary run is a release registered before its container
   * starts, so nothing here is the normal path — this is for the endings a
   * release cannot survive: the loop killed outright, the host rebooted, a check
   * killing a child to prove what a crash leaves.
   *
   * The label carries the run id, so what is an orphan is a database question
   * and it is asked here rather than in the sandbox: a container is left alone
   * while any workspace still holds its run as live, which covers the runs this
   * very loop is about to reclaim as well as one a second loop is working on.
   */
  const reap = Effect.gen(function* () {
    const held = yield* sandbox.held;
    if (held.length === 0) {
      return 0;
    }

    const live = new Set<RunId>();
    for (const workspace of yield* allWorkspaces) {
      const rows = yield* runs
        .listLive({ workspaceId: workspace.id })
        .pipe(bestEffort("live runs could not be read", []));
      for (const row of rows) {
        live.add(row.id);
      }
    }

    const orphans = orphansOf({ held, live });
    for (const orphan of orphans) {
      yield* sandbox.remove(orphan.name);
    }
    return orphans.length;
  }).pipe(Effect.withSpan("Orchestrator.reap"));

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

    // After the rows are closed and not before: a run reconciled a moment ago
    // is no longer live, so its container is now correctly an orphan. Asking
    // first would leave exactly the containers this exists to remove.
    const containersReaped = yield* reap.pipe(
      bestEffort("containers could not be reaped", 0)
    );

    return {
      containersReaped,
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
      const lane = laneOf(context.attached);
      yield* Effect.logWarning(
        `run ${input.run.id} on ${subjectKeyOf(subjectOfAttachment(context.attached))} was lost — closing it out`
      );
      // The same terminal path a run that died in front of the loop takes: the
      // run row is already closed by the reconcile, which this treats as the
      // ordinary agreement it is, and what it was attached to, the session and
      // the move to *review* are what is actually left to do.
      yield* closeRun({
        branch: null,
        commentPosted: false,
        context,
        // A run whose loop process died is the case with the most to salvage:
        // it wrote no comment, and whatever it left in its artifacts directory
        // is all there is of it. The handoff is read here for the same reason
        // it is read on the ordinary path.
        dataRoot: config.dataRoot,
        terminus,
      });
      yield* emitLostRun({
        context,
        eventsSeen: terminus.eventsSeen,
        lane,
        laneCapacity: pool.capacityOf(lane),
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

  /**
   * Which variables a turn is given, said once at boot. Names only — every
   * value here is a credential, and the operator's question is which
   * capabilities a run has at all, which the names answer.
   *
   * The GitHub line is separate because its absence has a specific consequence
   * worth naming at boot rather than at the end of the first run that tries to
   * push: a private repository cannot be cloned, and `gh` is not logged in.
   */
  const announceTurnEnv = Effect.gen(function* () {
    const names = Object.keys(turnEnv).sort();
    yield* names.length === 0
      ? Effect.logWarning(
          `turns run with no connector tools: set ${EXECUTOR_URL_ENV_VAR} and ${EXECUTOR_KEY_ENV_VAR} to give them Executor`
        )
      : Effect.logInfo(`turns are given ${names.join(", ")}`);
    yield* GH_TOKEN_ENV_VAR in turnEnv
      ? Effect.logInfo(
          "turns carry a GitHub credential: `gh` is logged in and git can push"
        )
      : Effect.logWarning(
          `turns have no GitHub credential: set ${AGENT_TOKEN_ENV_VAR} to clone a private repository or let an agent open a pull request`
        );
  });

  const run = Effect.gen(function* () {
    yield* announceSandbox;
    yield* announceTurnEnv;
    yield* Effect.logInfo(
      `loop listening on ${config.maxConcurrency} work slots and ${config.maxChatConcurrency} chat slots, polling every ${config.pollIntervalMs}ms`
    );
    yield* config.gatewayUrl === null
      ? Effect.logWarning(
          "turns run with no board tools: set ORCHESTRATOR_GATEWAY_URL to the gateway as a container sees it"
        )
      : Effect.logInfo(`turns reach the board at ${config.gatewayUrl}`);
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
