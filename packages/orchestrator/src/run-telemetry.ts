/**
 * The `atm.run` wide event: two rows per run, and the bounded counters derived
 * from them. This is the canonical record of the system — every other event
 * exists to join to it.
 *
 * A run is the unit of work the loop owns: one claimed task, from the moment
 * the lease is taken to the moment the task lands back in *review*. The
 * `atm.turn` row is written inside the container and the `atm.sandbox` row
 * around it, both carrying this run's id — so the questions asked here are the
 * ones neither can answer: how long the task waited for a slot, how deep the
 * pool was when it got one, which attempt this was and how many are left,
 * whether the resume actually resumed, and how the whole thing ended.
 *
 * Three properties are load-bearing, and this file enforces each rather than
 * documenting it.
 *
 * **Two rows, one runId, one emit site.** A `phase: "start"` row when the lease
 * is claimed and a terminus row on the way out, both from
 * {@link withRunEvent} and from nowhere else. That pairing is what turns an OOM
 * kill, a `SIGKILL` past the shutdown grace period, or a box that lost power
 * into a countable `lost` run instead of silence, and it is what makes a live
 * run visible at all. Parking in particular is not a third row: it is the
 * outcome of the attempt that just failed, because a park emitted separately is
 * one run counted twice.
 *
 * **Economics come from the terminus or not at all.** An interrupted run did
 * not cost $0.00 and a run nobody heard from did not take 0ms; `RunTerminus`
 * nulls what it does not know and this file nulls the lot where there is no
 * terminus, so no branch here writes a zero.
 *
 * **Content is measured, never carried.** The prompt is a character count, the
 * repo is `owner/name` parsed out of a URL that may hold a token, the final
 * assistant message is the boolean saying whether it became the fallback
 * message.
 *
 * This runs on the host, in a loop that outlives its export interval, which is
 * what makes the metrics at the bottom legal.
 */

import {
  costUsdToNumber,
  parseRepoUrl,
  RUN_ROLES,
  RunRole,
  RunTrigger,
  SESSION_PROVIDERS,
  SessionProvider,
  TaskStatus,
} from "@workspace/domain";
import { SANDBOX_KINDS, SandboxKind } from "@workspace/sandbox";
import {
  BASE_OUTCOMES,
  boundedCounter,
  boundedHistogram,
  defineEvent,
  emitEvent,
  outcomeField,
  SanitizedText,
  type WideEventContext,
  withWideEvent,
} from "@workspace/telemetry";
import {
  Cause,
  Clock,
  Effect,
  Exit,
  Metric,
  Option,
  Ref,
  Schema,
} from "effect";
import type { OrchestratorConfig } from "./config";
import {
  type DispatchContext,
  economicsOf,
  errorFieldsOf,
  eventIdentityOf,
  outcomeOfTerminus,
  projectIdOf,
  type RunTerminus,
  resumeSessionIdOf,
  roleOf,
} from "./dispatch-context";
import { describeFailure, type RunErrorClass } from "./errors";
import { POOL_LANES, type PoolLane } from "./pool";

/** The filter key every query over this system starts from. */
export const RUN_EVENT_MARKER = "atm.run";

/**
 * The endings the base outcome union cannot express, each one a thing that
 * stops being visible the moment it is folded into `errored`. `lost` is a run
 * that went quiet, the whole reason two rows are written; `parked` is the retry
 * ladder ending, a decision about the task rather than a way the container
 * died; `skipped` is a dispatch that declined to create work at all.
 */
export const RUN_EVENT_EXTRA_OUTCOMES = ["lost", "parked", "skipped"] as const;

/** Every way a run row can end, for the metric's tag vocabulary. */
// biome-ignore format: one line reads as the union it is
export const RUN_EVENT_OUTCOMES = [...BASE_OUTCOMES, ...RUN_EVENT_EXTRA_OUTCOMES] as const;

/** How a run ended, as the ledger and the counters spell it. */
export type RunEventOutcome = (typeof RUN_EVENT_OUTCOMES)[number];

/** Whether this run started a conversation or continued one. */
const SESSION_MODES = ["fresh", "resumed"] as const;

/**
 * The selections a task's next-session field can hold. Assigning
 * `ResolvedSession["selected"]` into it keeps the tuple exhaustive: a mode
 * added to the domain fails to compile here rather than reaching the ledger.
 */
const SESSION_SELECTIONS = ["latest", "new", "specific"] as const;

/**
 * The two classes that mean the dispatcher declined rather than that a run
 * failed: one task already has a container, or a provider's allowance is spent.
 * Both are refusals that worked, and either in the error budget makes a healthy
 * concurrency guard look like an incident.
 */
const SKIP_CLASSES: ReadonlySet<RunErrorClass> = new Set<RunErrorClass>([
  "AlreadyLive",
  "QuotaPaused",
]);

/**
 * What the loop learned about a run on its way through. This exists for the
 * failing paths: a run that dies between the claim and the terminal event
 * returns nothing at all, and without a cell to read on the way out its row
 * would say the container never existed.
 */
export interface RunProgress {
  readonly artifactsWritten: number;
  /** The branch this run pushed. Null with no repo, or where it never got that far. */
  readonly branch: string | null;
  /** Normalized events ingested into `run_events` — what tells a container that died early from one that died late. */
  readonly eventsSeen: number;
  /**
   * The instruction files the run's tree was about to hand it, in bytes. Null
   * for a host turn, which walks no tree, and on a row written before the
   * directories existed.
   */
  readonly instructionBytes: number | null;
  /** True when the loop appended the final assistant message because the run posted no message of its own. */
  readonly messageFallback: boolean;
  readonly parked: boolean;
  /**
   * The commit the project scope stood at when this run was handed it. Null on
   * a run with no project, and where the scope has no history.
   */
  readonly projectCommit: string | null;
  readonly promptChars: number | null;
  /** The pull request the task carries once the run has closed, or null for the many runs that produce none. */
  readonly prUrl: string | null;
  readonly retryInMs: number | null;
  /** How the run ended, once one of the three endings is known. */
  readonly terminus: RunTerminus | null;
  /**
   * The commit the workspace scope stood at when this run was handed it. Null
   * where the folder has no history — a fresh install, or a git that refused.
   */
  readonly workspaceCommit: string | null;
}

/** A run that has been claimed and has done nothing yet. */
export const emptyRunProgress: RunProgress = {
  artifactsWritten: 0,
  branch: null,
  eventsSeen: 0,
  instructionBytes: null,
  messageFallback: false,
  parked: false,
  projectCommit: null,
  promptChars: null,
  prUrl: null,
  retryInMs: null,
  terminus: null,
  workspaceCommit: null,
};

/** A fresh accumulator for one run. */
export const makeRunProgress = Ref.make(emptyRunProgress);

/**
 * Folds what the loop just learned into the accumulator. One patch rather than
 * eight setters, because the facts arrive in clusters — the ingest yields an
 * event count and a terminus, the close-out the fallback flag and the artifact
 * count.
 */
export const observeRunProgress = (
  progress: Ref.Ref<RunProgress>,
  patch: Partial<RunProgress>
) => Ref.update(progress, (current) => ({ ...current, ...patch }));

/**
 * One run. The shared identity, economics, outcome and environment vocabulary
 * comes from the telemetry base; everything below it is a question about the
 * run that the base cannot answer. The base economics are the turn's roll-up,
 * so `durationMs` is what the provider reported and goes null with the rest of
 * them; `leaseDurationMs` is the loop's own measurement, real on every path.
 */
export const RunEvent = defineEvent(RUN_EVENT_MARKER, {
  artifactsWritten: Schema.Natural,
  /** 1-based, against {@link maxAttempts}: together they say how much rope is left. */
  attempt: Schema.Natural,
  branch: Schema.NullOr(SanitizedText),
  /** Normalized events ingested. A `lost` run with two of these died at startup; one with two hundred died at work. */
  eventsSeen: Schema.Natural,
  exitCode: Schema.NullOr(Schema.Int),
  image: SanitizedText,
  /**
   * How many bytes of instruction files the run's tree held when it was given
   * its directories, so "which runs were near the cliff" is a query rather than
   * a grep of the logs. Codex spends one budget across the whole tree root
   * first, and what it drops past that budget is the deepest and most specific
   * document. Null on a start row and on a host turn, which reads no tree.
   */
  instructionBytes: Schema.NullOr(Schema.Natural),
  /** Which sandbox implementation served the run, so a host run cannot be mistaken for a contained one. */
  kind: SandboxKind,
  /** Which lane's slot this run held: board work, or a conversation. */
  lane: Schema.Literals(POOL_LANES),
  /** Claim to terminus, measured by the loop across every exit path. Null on a start row, which has not ended. */
  leaseDurationMs: Schema.NullOr(Schema.Number),
  maxAttempts: Schema.Natural,
  /** The lane's cap, without which {@link poolDepth} does not say whether it was full. */
  maxConcurrency: Schema.Natural,
  /** True when the run said nothing of its own and the loop appended its last message. */
  messageFallback: Schema.Boolean,
  outcome: outcomeField(RUN_EVENT_EXTRA_OUTCOMES),
  /** Slots held in this run's lane at the instant it took one. */
  poolDepth: Schema.Natural,
  /**
   * The commit the project scope stood at when the run was handed it: the same
   * question as `workspaceCommit`, one level down. Null on a run with no
   * project, and on a project folder with no history yet.
   */
  projectCommit: Schema.NullOr(SanitizedText),
  projectId: Schema.NullOr(SanitizedText),
  /** The prompt is measured, never carried. Null on a row written before it was built. */
  promptChars: Schema.NullOr(Schema.Natural),
  provider: SessionProvider,
  /** The provider's own conversation id, which is what the next resume is pointed at. */
  providerSessionId: Schema.NullOr(SanitizedText),
  /**
   * The pull request on the run's task once it closed, null where there is
   * none. Beside {@link branch}, and the pair is the question: a run that
   * pushed a branch and has no pull request is a change nobody can review.
   */
  prUrl: Schema.NullOr(SanitizedText),
  /** `owner/name`, parsed out of the URL — which may carry a token and never reaches a row. */
  repo: Schema.NullOr(SanitizedText),
  retryInMs: Schema.NullOr(Schema.Number),
  /** Which runtime this was: a worker on a card, or the manager in a thread. */
  role: RunRole,
  sessionMode: Schema.Literals(SESSION_MODES),
  /** What the task asked for, against what it got: a `latest` that resolves to `fresh` is a task with no sessions. */
  sessionSelected: Schema.Literals(SESSION_SELECTIONS),
  /** The column the task was claimed from, or null on a run with no card. */
  taskStatus: Schema.NullOr(TaskStatus),
  /**
   * The conversation a manager run answered in, null on a worker run. Declared
   * here rather than in the telemetry base beside `taskId`, because a thread is
   * this system's idea and the base is the shape every unit of work shares.
   */
  threadId: Schema.NullOr(SanitizedText),
  trigger: RunTrigger,
  /**
   * The commit the workspace scope stood at when this run was given its
   * directories, so "which rules did that run have" is a lookup rather than a
   * guess. House style, the shared instruction files and everything else in that
   * folder live in a git repository the loop snapshots before every run, and a
   * commit points at bytes somebody can still read — which a hash of the tree
   * would not. Null on a start row, and where the folder has no history yet.
   */
  workspaceCommit: Schema.NullOr(SanitizedText),
});

/** The row one run supplies, derived from the schema so it cannot drift. */
export type RunEventInput = Parameters<typeof RunEvent.encode>[0];

/** The caps a row reports, off the loop's own config so a row cannot claim one the dispatcher is not honouring. */
export type RunEventSettings = Pick<
  OrchestratorConfig,
  "maxAttempts" | "sandboxKind"
>;

/** What the emit site knows about one run. */
export interface RunEventContext {
  /** Everything resolved at the claim: the attachment, project, session, image, ids, attempt. */
  readonly dispatch: DispatchContext;
  /** Which lane's slot this run holds, and the cap on it. */
  readonly lane: PoolLane;
  /** The lane's cap, so a depth is readable as "was it full". */
  readonly laneCapacity: number;
  /** How many runs already held a slot in that lane when this one claimed its lease. */
  readonly poolDepth: number;
  /** The cell the loop folds its facts into; read once, as the run exits. */
  readonly progress: Ref.Ref<RunProgress>;
  readonly settings: RunEventSettings;
}

/**
 * What a row is built from, minus the cell the loop folds its facts into. The
 * accumulator is read by the caller and passed in, so the one emit that has no
 * running fiber behind it — a lost run, closed at boot — does not have to invent
 * a `Ref` to satisfy a signature.
 */
type RunEventClaim = Omit<RunEventContext, "progress">;

/**
 * The repo as a row may carry it: a clone URL can hold `x-access-token:ghp_…`
 * in its userinfo, so only the parsed `owner/name` goes out, and an unparseable
 * URL is null rather than a redacted guess.
 */
const repoSlugOf = (repoUrl: string | null) => {
  if (repoUrl === null) {
    return null;
  }
  const repo = parseRepoUrl(repoUrl);
  return repo === null ? null : repo.slug;
};

/** How the run ended, and what to call the failure behind it. */
interface RunEnding {
  readonly errorClass: RunErrorClass | null;
  readonly errorMessage: string | null;
  readonly outcome: RunEventOutcome;
}

/** The domain outcome, widened to `skipped` where the class says the loop declined. */
const widened = (
  errorClass: RunErrorClass | null,
  outcome: RunEventOutcome
): RunEventOutcome =>
  errorClass !== null && SKIP_CLASSES.has(errorClass) ? "skipped" : outcome;

/** The ending a recorded terminus names. */
const endingOfTerminus = (terminus: RunTerminus): RunEnding => {
  const fields = errorFieldsOf(terminus);
  return {
    ...fields,
    outcome: widened(fields.errorClass, outcomeOfTerminus(terminus)),
  };
};

/**
 * Reads the ending off the exit and the accumulator together, because neither
 * knows it alone. The exit is asked first: a run that recorded a terminus and
 * then failed to write its record still failed, and the terminus's `done` would
 * leave the row green while the loop dropped the run's history. An interrupt
 * outranks everything, including the park.
 *
 * Parking is applied last and changes only the outcome — the attempt keeps the
 * class and message it failed with — which is what makes the park a property of
 * this row rather than a second emit.
 */
const endingOf = (
  exit: Exit.Exit<unknown, unknown>,
  progress: RunProgress
): RunEnding => {
  const ending = endingBeforeParking(exit, progress);
  return progress.parked &&
    ending.outcome !== "done" &&
    ending.outcome !== "interrupted"
    ? { ...ending, outcome: "parked" }
    : ending;
};

/** The ending the exit and the terminus agree on, before the park is applied. */
const endingBeforeParking = (
  exit: Exit.Exit<unknown, unknown>,
  progress: RunProgress
): RunEnding => {
  if (exit._tag === "Success") {
    // A clean loop that never produced a terminus is a run nobody heard from,
    // and calling that `done` is how a broken container looks healthy.
    return progress.terminus === null
      ? {
          errorClass: "NoTerminalEvent",
          errorMessage: `the run produced ${progress.eventsSeen} events and no terminus`,
          outcome: "lost",
        }
      : endingOfTerminus(progress.terminus);
  }
  // Only a cause that is nothing but interrupts is a stop: work that failed and
  // was then torn down really failed, and calling it `interrupted` hides it.
  if (Cause.hasInterruptsOnly(exit.cause)) {
    // A stop command is not a thing that went wrong with a run, so it carries
    // no class: this package's classes are all faults, and none of them is one.
    return { errorClass: null, errorMessage: null, outcome: "interrupted" };
  }
  const failure = Cause.findErrorOption(exit.cause);
  const thrown = Option.isSome(failure)
    ? failure.value
    : Cause.squash(exit.cause);
  // The one classifier the run lifecycle calls: it names a harness tag, a
  // sandbox tag, a repository tag and raw text alike, already sanitized.
  const described = describeFailure(thrown);
  return {
    ...described,
    outcome: widened(described.errorClass, described.outcome),
  };
};

/**
 * What the run cost, from the only thing that knows: the terminus. Null where
 * there is none, and on an interrupt even when one was recorded — a run killed
 * mid-flight has a partial reading, and a partial number stored as final is one
 * someone later averages.
 */
const economicsFor = (progress: RunProgress, ending: RunEnding) => {
  if (progress.terminus === null || ending.outcome === "interrupted") {
    return { costUsd: null, durationMs: null, totalTokens: null, turns: null };
  }
  const economics = economicsOf(progress.terminus);
  return {
    ...economics,
    costUsd:
      economics.costUsd === null ? null : costUsdToNumber(economics.costUsd),
  };
};

/** The ids this row joins on: the claim span's, falling back to whatever span is emitting. */
const identityOf = (
  dispatch: DispatchContext,
  wide: Pick<WideEventContext<never, never>, "spanId" | "traceId"> | null
) => {
  const identity = eventIdentityOf(dispatch);
  return {
    ...identity,
    spanId: identity.spanId ?? wide?.spanId ?? null,
    traceId: identity.traceId ?? wide?.traceId ?? null,
  };
};

/** Everything decided at the claim, identical on both of a run's rows. */
const claimFields = (
  context: RunEventClaim,
  identity: ReturnType<typeof identityOf>
) => {
  const { dispatch, settings } = context;
  return {
    attempt: dispatch.attempt,
    image: dispatch.image,
    kind: settings.sandboxKind,
    lane: context.lane,
    maxAttempts: settings.maxAttempts,
    maxConcurrency: context.laneCapacity,
    poolDepth: context.poolDepth,
    projectId: projectIdOf(dispatch),
    provider: dispatch.provider,
    // Measured before this run existed, so it is real on both rows: how long the
    // task sat in its column waiting for a slot.
    queueWaitMs: dispatch.queueWaitMs,
    repo: repoSlugOf(dispatch.repoUrl),
    role: roleOf(dispatch),
    runId: identity.runId,
    sessionId: identity.sessionId,
    sessionMode: dispatch.session.mode,
    sessionSelected: dispatch.session.selected,
    spanId: identity.spanId,
    taskId: identity.taskId,
    taskStatus:
      dispatch.attached.role === "worker"
        ? dispatch.attached.task.status
        : null,
    threadId: identity.threadId,
    traceId: identity.traceId,
    trigger: dispatch.trigger,
    workspaceId: identity.workspaceId,
  };
};

/**
 * One row of a run, from the three things that know about it: what was decided
 * at the claim, what the loop accumulated, and how it ended.
 *
 * `wide` is null for the start row, which is what makes this one function
 * rather than two: the claim row is this row over an empty accumulator and an
 * ending nobody has reached, so a run's two rows cannot drift apart in which
 * fields they carry. Everything unknown is null rather than a placeholder,
 * except the counts, which are honest zeroes.
 */
const runRow = (
  context: RunEventClaim,
  progress: RunProgress,
  wide: WideEventContext<unknown, unknown> | null
): RunEventInput => {
  const ending = wide === null ? null : endingOf(wide.exit, progress);
  const { terminus } = progress;
  return {
    ...claimFields(context, identityOf(context.dispatch, wide)),
    // No numbers at all before the work: none of them exist yet.
    ...(ending === null
      ? { costUsd: null, durationMs: null, totalTokens: null, turns: null }
      : economicsFor(progress, ending)),
    artifactsWritten: progress.artifactsWritten,
    branch: progress.branch,
    errorClass: ending?.errorClass ?? null,
    errorMessage: ending?.errorMessage ?? null,
    eventsSeen: progress.eventsSeen,
    exitCode: terminus?.exitCode ?? null,
    instructionBytes: progress.instructionBytes,
    // Measured across every exit path, so it is real where the economics are
    // not: a run killed at four minutes genuinely held its slot for four
    // minutes, and that is the number the pool is sized against.
    leaseDurationMs: wide === null ? null : wide.durationMs,
    messageFallback: progress.messageFallback,
    outcome: ending?.outcome ?? null,
    phase: wide === null ? "start" : "end",
    // Where the shared folders stood when this run was handed them, so the rules
    // it read are a `git show` away rather than whatever those folders hold now.
    projectCommit: progress.projectCommit,
    promptChars: progress.promptChars,
    // The resume id is known at the claim, which is what makes a start row
    // enough to find the conversation a wedged run is stuck in.
    providerSessionId:
      terminus?.providerSessionId ?? resumeSessionIdOf(context.dispatch),
    prUrl: progress.prUrl,
    retryInMs: progress.retryInMs,
    workspaceCommit: progress.workspaceCommit,
  };
};

/** A run the loop found already over, and the settings the row reports. */
export interface LostRunInput {
  readonly context: DispatchContext;
  /** How far the run's own event file got before it stopped. */
  readonly eventsSeen: number;
  /** The lane this run would have held, so the row is comparable to a live one's. */
  readonly lane: PoolLane;
  readonly laneCapacity: number;
  readonly settings: RunEventSettings;
  readonly terminus: RunTerminus;
}

/**
 * The terminus row for a run nobody was left to write one for.
 *
 * The reconcile at boot is the only caller and it is a second emit site by
 * necessity rather than by choice: the process that owned the run is gone, so
 * `withRunEvent` cannot close what it opened, and the start row it left behind
 * would otherwise stay a run that never ended. One row, `phase: "end"`, sharing
 * the `runId` of that start — which is exactly the pairing the two-row shape
 * exists to make queryable.
 *
 * The economics stay null and `leaseDurationMs` with them: the loop that held
 * this run measured nothing that survived it, and a duration computed at
 * reconcile time would be the age of the crash rather than the length of the
 * run.
 */
export const emitLostRun = (input: LostRunInput) =>
  emitEvent(RunEvent, {
    ...runRow(
      {
        dispatch: input.context,
        lane: input.lane,
        laneCapacity: input.laneCapacity,
        // Nothing was holding a slot for this run by the time it was found.
        poolDepth: 0,
        settings: input.settings,
      },
      {
        ...emptyRunProgress,
        eventsSeen: input.eventsSeen,
        terminus: input.terminus,
      },
      {
        durationMs: 0,
        exit: Exit.succeed(undefined),
        spanId: null,
        traceId: null,
      }
    ),
    leaseDurationMs: null,
  });

/** Run durations span a second to a couple of hours; the buckets follow. */
const DURATION_MS_BOUNDARIES = Metric.exponentialBoundaries({
  count: 14,
  factor: 2,
  start: 1000,
});

// biome-ignore lint/style/noMagicNumbers: bucket boundaries are the constant
const COST_USD_BOUNDARIES = [0.01, 0.05, 0.1, 0.25, 0.5, 1, 2, 5, 10, 20];

// biome-ignore lint/style/noMagicNumbers: bucket boundaries are the constant
const TURNS_BOUNDARIES = [1, 2, 5, 10, 20, 50, 100, 200];

/**
 * The bounded projection of the same event. Every tag is drawn from a `const`
 * tuple, so an unlisted value is a compile error rather than a new time series,
 * and the ids that make the event worth querying — run, task, session,
 * workspace, project, repo — stay off it. The ceiling is 2 × 7 × 2 series.
 */
const runsTotal = boundedCounter("atm_runs_total", {
  description: "Runs terminated, by sandbox kind, ending, provider and role",
  tags: {
    kind: SANDBOX_KINDS,
    outcome: RUN_EVENT_OUTCOMES,
    provider: SESSION_PROVIDERS,
    role: RUN_ROLES,
  },
});

const retriesTotal = boundedCounter("atm_retries_total", {
  description: "Runs that failed and scheduled another attempt",
  tags: { provider: SESSION_PROVIDERS },
});

const parkedTotal = boundedCounter("atm_parked_total", {
  description: "Runs whose task was parked after exhausting its attempts",
  tags: { provider: SESSION_PROVIDERS },
});

/**
 * Derived from the same ending as every other counter rather than incremented
 * by the quota gate: a pause that stops no work is a state, and what is worth
 * counting is the work it stopped.
 */
const quotaPauseTotal = boundedCounter("atm_quota_pause_total", {
  description: "Dispatches refused because a provider's allowance was spent",
  tags: { provider: SESSION_PROVIDERS },
});

/** Claim to terminus, split by ending: an interrupted run is short for a reason. */
const runDurationMs = boundedHistogram("atm_run_duration_ms", {
  boundaries: DURATION_MS_BOUNDARIES,
  description: "Lease claim to terminus, per run",
  tags: { outcome: RUN_EVENT_OUTCOMES, provider: SESSION_PROVIDERS },
});

const runCostUsd = boundedHistogram("atm_run_cost_usd", {
  boundaries: COST_USD_BOUNDARIES,
  description: "Provider-reported cost per run, where one was reported",
  tags: { provider: SESSION_PROVIDERS },
});

const runTurns = boundedHistogram("atm_run_turns", {
  boundaries: TURNS_BOUNDARIES,
  description: "Provider-reported turns per run, where they were reported",
  tags: { provider: SESSION_PROVIDERS },
});

/**
 * Counts the run from the same ending the row reports, so the counters and the
 * ledger cannot disagree, and takes only the numbers that exist: a 0 for a
 * degraded run moves a percentile that describes the runs which did work.
 * Swallows its own failures — a metric may never mask the work it describes.
 */
const recordRunMetrics = (
  context: RunEventContext,
  exit: Exit.Exit<unknown, unknown>,
  claimedAtMs: number
) =>
  Effect.gen(function* () {
    const progress = yield* Ref.get(context.progress);
    const ending = endingOf(exit, progress);
    const { provider } = context.dispatch;
    const economics = economicsFor(progress, ending);
    const now = yield* Clock.currentTimeMillis;
    yield* runsTotal.increment({
      kind: context.settings.sandboxKind,
      outcome: ending.outcome,
      provider,
      role: roleOf(context.dispatch),
    });
    if (progress.retryInMs !== null) {
      yield* retriesTotal.increment({ provider });
    }
    if (ending.outcome === "parked") {
      yield* parkedTotal.increment({ provider });
    }
    if (ending.errorClass === "QuotaPaused") {
      yield* quotaPauseTotal.increment({ provider });
    }
    yield* runDurationMs.record(
      { outcome: ending.outcome, provider },
      Math.max(0, now - claimedAtMs)
    );
    if (economics.costUsd !== null) {
      yield* runCostUsd.record({ provider }, economics.costUsd);
    }
    if (economics.turns !== null) {
      yield* runTurns.record({ provider }, economics.turns);
    }
  }).pipe(Effect.ignoreCause);

/**
 * Wraps one run so it leaves exactly two `atm.run` rows sharing a `runId`: a
 * `start` row as the lease is claimed, and a terminus row on every exit path —
 * a clean finish, a typed failure, a defect, and the interrupt a stop command
 * or a shutdown produces.
 *
 * Wrap at the claim, not at the container: `leaseDurationMs` is how long the
 * slot was held, prompt build and workspace clone and close-out included, and
 * those are the parts a pool of two is actually starved by.
 *
 * No span is opened here. The claim span is the dispatcher's, its ids are
 * already on the {@link DispatchContext}, and its `traceparent` is what the
 * container was started with — a second span would give this row trace ids the
 * `atm.turn` rows inside the container do not share.
 *
 * The accumulator is read synchronously as the run exits, which is safe
 * precisely there: the fiber that wrote it has finished by then.
 *
 * @example
 * ```ts
 * const execute = (dispatch: DispatchContext, poolDepth: number) =>
 *   Effect.gen(function* () {
 *     const progress = yield* makeRunProgress;
 *     const work = Effect.gen(function* () {
 *       const prompt = yield* buildRunPrompt(dispatch);
 *       yield* observeRunProgress(progress, { promptChars: prompt.chars });
 *       const terminus = yield* runContainer(dispatch, prompt);
 *       yield* observeRunProgress(progress, { eventsSeen, terminus });
 *       yield* observeRunProgress(progress, yield* closeOut(dispatch, terminus));
 *     });
 *     return yield* work.pipe(
 *       withRunEvent({ dispatch, poolDepth, progress, settings })
 *     );
 *   });
 * ```
 */
export const withRunEvent =
  (context: RunEventContext) =>
  <A, E, R>(effect: Effect.Effect<A, E, R>) =>
    Effect.gen(function* () {
      const claimedAtMs = yield* Clock.currentTimeMillis;
      // Before the work, so a process killed mid-run still leaves the row that
      // makes it a `lost` run rather than nothing at all.
      yield* emitEvent(RunEvent, runRow(context, emptyRunProgress, null));
      return yield* effect.pipe(
        // Inside the wide event, so the counters are derived before the ledger
        // write rather than after it, and the duration they record is the
        // run's rather than the run's plus an append.
        Effect.onExit((exit) => recordRunMetrics(context, exit, claimedAtMs)),
        withWideEvent(RunEvent, (wide: WideEventContext<A, E>) =>
          runRow(context, Ref.getUnsafe(context.progress), wide)
        )
      );
    });
