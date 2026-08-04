/**
 * The `atm.turn` wide event: one row per provider invocation, and the counters
 * a turn accumulates on its way to producing it.
 *
 * A turn is the unit of work the harness owns — one prompt handed to one
 * provider, streaming until it ends. Everything worth counting about it is a
 * field here rather than a log line, because the questions asked afterwards are
 * "which provider fails more", "does cost scale with prompt size", "how far did
 * the interrupted turns get" — every one of them a `GROUP BY` over a column
 * that has to already exist.
 *
 * Three properties are load-bearing and each one is a rule this file enforces
 * rather than documents. The row is emitted exactly once on every exit path,
 * which is why the emit goes through {@link withWideEvent} and is never
 * hand-rolled: a failure, a defect and an interrupt all leave a row, and an
 * interrupt is the common case because that is what a stop command is. The
 * economics are null on every outcome but `done`, because a turn killed halfway
 * reported a partial cost and a partial token count, and a partial number
 * stored as if it were final is a number someone later averages. And content is
 * measured, never carried: the prompt is a character count, the reasoning is a
 * character count, and no assistant text, transcript or file content reaches a
 * row.
 *
 * The identity a row joins on comes from the environment the orchestrator
 * passed into the container. That is the whole point of {@link TURN_ENV_VARS}:
 * the harness runs in a sandbox with no database and no idea which run it
 * serves, so the ids ride in as environment variables and the row it writes
 * joins the `atm.run` row the host wrote for the same work.
 */

import {
  type CostUsd,
  costUsdToNumber,
  SessionProvider,
} from "@workspace/domain";
import {
  clipError,
  defineEvent,
  outcomeField,
  SanitizedText,
  type WideEventContext,
  withWideEvent,
} from "@workspace/telemetry";
import { Cause, Config, Effect, type Exit, Option, Ref, Schema } from "effect";
import { trimmedOrNull } from "./env";
import {
  classify,
  describeError,
  type HarnessError,
  type HarnessErrorClass,
  outcomeOfClass,
  type TurnOutcome,
} from "./errors";
import { type AgentEvent, RateLimitStatus } from "./events";

/** The filter key every query over agent turns starts from. */
export const TURN_EVENT_MARKER = "atm.turn";

/**
 * The environment variables carrying this turn's correlation ids into the
 * container. The sandbox sets exactly these and the harness reads exactly
 * these, so the contract is one object rather than two spellings that drift.
 *
 * `ATM_SESSION_ID` carries the agent session, not a browser login: inside the
 * container there is no other kind of session for the name to be confused with.
 */
export const TURN_ENV_VARS = {
  runId: "ATM_RUN_ID",
  sessionId: "ATM_SESSION_ID",
  taskId: "ATM_TASK_ID",
  workspaceId: "ATM_WORKSPACE_ID",
} as const;

/** The ids one turn joins on, each null where nothing supplied it. */
export interface TurnIdentity {
  readonly runId: string | null;
  readonly sessionId: string | null;
  readonly taskId: string | null;
  readonly workspaceId: string | null;
}

/**
 * One id from the container's environment. Unreadable and unset are the same
 * answer — a correlation id nobody supplied is null, and failing the turn over
 * it would let telemetry abort the work it describes.
 */
const readId = (name: string) =>
  Config.string(name).pipe(
    Effect.orElseSucceed(() => null),
    Effect.map(trimmedOrNull)
  );

/**
 * The turn's correlation ids: whatever the caller already holds, falling back
 * to the environment the orchestrator passed in. Never fails — a container
 * started by hand has no ids and writes a row with nulls, which is still a row.
 */
export const readTurnIdentity = (overrides: Partial<TurnIdentity> = {}) =>
  Effect.gen(function* () {
    const runId = yield* readId(TURN_ENV_VARS.runId);
    const sessionId = yield* readId(TURN_ENV_VARS.sessionId);
    const taskId = yield* readId(TURN_ENV_VARS.taskId);
    const workspaceId = yield* readId(TURN_ENV_VARS.workspaceId);
    return {
      runId: overrides.runId ?? runId,
      sessionId: overrides.sessionId ?? sessionId,
      taskId: overrides.taskId ?? taskId,
      workspaceId: overrides.workspaceId ?? workspaceId,
    } satisfies TurnIdentity;
  });

/**
 * What a turn accumulated while it streamed. Folded from the normalized events
 * themselves rather than tallied by each provider, so the two providers cannot
 * disagree about what a tool call is.
 *
 * The counts stay on the row even when the turn ends badly — they are
 * measurements of what actually happened, not a roll-up the provider promised,
 * and "the interrupted turns had run 40 tools" is the answer that makes an
 * interrupt worth investigating.
 */
export interface TurnCounters {
  /** Characters of assistant text, measured. The text itself never lands on a row. */
  readonly assistantChars: number;
  readonly assistantMessages: number;
  /** The turn's cost, from the terminus or the last usage reading that carried one. */
  readonly costUsd: CostUsd | null;
  /** Set by the terminus on every outcome but `done`. */
  readonly errorClass: HarnessErrorClass | null;
  /** Mid-turn failures the provider recovered from. A green turn with ten of these is worth seeing. */
  readonly errorEvents: number;
  readonly errorMessage: string | null;
  /** How many normalized events the stream produced — what tells a silent provider from a dead one. */
  readonly eventsSeen: number;
  readonly inputTokens: number | null;
  /** The model the provider actually chose, which is not always the one asked for. */
  readonly model: string | null;
  /** The terminus, or null where the stream ended without one. */
  readonly outcome: TurnOutcome | null;
  readonly outputTokens: number | null;
  readonly providerSessionId: string | null;
  /** Highest utilization the provider reported during the turn, 0–100. */
  readonly rateLimitPeakPct: number | null;
  /** The worst reading seen, not the last: a warning that later cleared still happened. */
  readonly rateLimitStatus: RateLimitStatus | null;
  readonly rateLimitType: string | null;
  readonly reasoningChars: number;
  readonly subagents: number;
  readonly toolCalls: number;
  readonly toolErrors: number;
  readonly totalTokens: number | null;
  readonly turns: number | null;
}

/** A turn that has produced nothing yet. */
export const emptyTurnCounters: TurnCounters = {
  assistantChars: 0,
  assistantMessages: 0,
  costUsd: null,
  errorClass: null,
  errorEvents: 0,
  errorMessage: null,
  eventsSeen: 0,
  inputTokens: null,
  model: null,
  outcome: null,
  outputTokens: null,
  providerSessionId: null,
  rateLimitPeakPct: null,
  rateLimitStatus: null,
  rateLimitType: null,
  reasoningChars: 0,
  subagents: 0,
  toolCalls: 0,
  toolErrors: 0,
  totalTokens: null,
  turns: null,
};

/** A fresh counter cell for one turn. */
export const makeTurnCounters = Ref.make(emptyTurnCounters);

/**
 * How bad each rate-limit reading is. A turn keeps the worst one it saw:
 * `allowed_warning` arrives before a provider starts refusing, and a later
 * `allowed` does not undo the fact that the window nearly closed.
 */
const RATE_LIMIT_SEVERITY = {
  allowed: 0,
  allowed_warning: 1,
  rejected: 2,
} as const satisfies Record<RateLimitStatus, number>;

const worstRateLimit = (
  current: RateLimitStatus | null,
  next: RateLimitStatus | null
) => {
  if (current === null || next === null) {
    return next ?? current;
  }
  return RATE_LIMIT_SEVERITY[next] > RATE_LIMIT_SEVERITY[current]
    ? next
    : current;
};

/** Keeps the larger of two readings, treating an absent one as no reading. */
const peak = (current: number | null, next: number | null) => {
  if (current === null || next === null) {
    return next ?? current;
  }
  return Math.max(current, next);
};

/** Keeps whichever value is present, preferring the newer one. */
const latest = <A>(current: A | null, next: A | null) => next ?? current;

/**
 * Folds one normalized event into the turn's counters. Pure and total, so the
 * whole tally is testable without a provider.
 */
export const countTurnEvent = (
  counters: TurnCounters,
  event: AgentEvent
): TurnCounters => {
  const seen = { ...counters, eventsSeen: counters.eventsSeen + 1 };
  switch (event.kind) {
    case "assistant_text":
      return {
        ...seen,
        assistantChars: seen.assistantChars + event.text.length,
        assistantMessages: seen.assistantMessages + 1,
      };
    case "error":
      return { ...seen, errorEvents: seen.errorEvents + 1 };
    case "reasoning":
      return { ...seen, reasoningChars: seen.reasoningChars + event.chars };
    case "result":
      return {
        ...seen,
        costUsd: latest(seen.costUsd, event.costUsd),
        errorClass: event.errorClass,
        errorMessage: event.errorMessage,
        outcome: event.outcome,
        providerSessionId: latest(
          seen.providerSessionId,
          event.providerSessionId
        ),
        totalTokens: latest(seen.totalTokens, event.totalTokens),
        turns: latest(seen.turns, event.turns),
      };
    case "session_init":
      return {
        ...seen,
        model: latest(seen.model, event.model),
        providerSessionId: event.providerSessionId,
      };
    case "subagent_started":
      return { ...seen, subagents: seen.subagents + 1 };
    case "tool_call":
      return { ...seen, toolCalls: seen.toolCalls + 1 };
    case "tool_result":
      return { ...seen, toolErrors: seen.toolErrors + (event.ok ? 0 : 1) };
    case "usage":
      return {
        ...seen,
        costUsd: latest(seen.costUsd, event.costUsd),
        inputTokens: latest(seen.inputTokens, event.inputTokens),
        outputTokens: latest(seen.outputTokens, event.outputTokens),
        rateLimitPeakPct: peak(seen.rateLimitPeakPct, event.rateLimitPct),
        rateLimitStatus: worstRateLimit(
          seen.rateLimitStatus,
          event.rateLimitStatus
        ),
        rateLimitType: latest(seen.rateLimitType, event.rateLimitType),
        turns: latest(seen.turns, event.turns),
      };
    default:
      return seen;
  }
};

/** Folds one event into a turn's counters. The single call a provider makes per event. */
export const observeTurnEvent = (
  counters: Ref.Ref<TurnCounters>,
  event: AgentEvent
) => Ref.update(counters, (current) => countTurnEvent(current, event));

/**
 * The turn's token total: the provider's own roll-up where it gave one, and the
 * two halves added only when both are known. Adding a known half to an unknown
 * one would report a total that is quietly too small.
 */
const totalTokensOf = (counters: TurnCounters) => {
  if (counters.totalTokens !== null) {
    return counters.totalTokens;
  }
  return counters.inputTokens !== null && counters.outputTokens !== null
    ? counters.inputTokens + counters.outputTokens
    : null;
};

/** The text a defect carries, before it is clipped. */
const defectMessage = (defect: unknown) =>
  defect instanceof Error ? defect.message : String(defect);

/** How the turn ended, and what to call the failure behind it. */
interface TurnEnding {
  readonly errorClass: HarnessErrorClass | null;
  readonly errorMessage: string | null;
  readonly outcome: TurnOutcome;
}

/**
 * Reads the ending off the exit and the counters together, because neither
 * knows it alone: a provider that streams a terminus and then returns cleanly
 * reports its own outcome, while an interrupt, a typed failure and a defect
 * only exist on the exit. A success with no terminus is the third case, and it
 * is `no_terminal_event` rather than `done` — a stream that stopped talking
 * produced nothing, and counting it as a success is how a broken provider looks
 * healthy.
 */
const endingOf = (
  exit: Exit.Exit<unknown, HarnessError>,
  counters: TurnCounters
): TurnEnding => {
  if (exit._tag === "Success") {
    return counters.outcome === null
      ? {
          errorClass: "NoTerminalEvent",
          errorMessage: `the provider stream ended after ${counters.eventsSeen} events without a terminus`,
          outcome: "no_terminal_event",
        }
      : {
          errorClass: counters.errorClass,
          errorMessage: counters.errorMessage,
          outcome: counters.outcome,
        };
  }
  // Only a cause that is nothing but interrupts is a stop: work that failed and
  // was then torn down really failed, and calling it `interrupted` hides it.
  if (Cause.hasInterruptsOnly(exit.cause)) {
    return {
      errorClass: "Interrupted",
      errorMessage: null,
      outcome: "interrupted",
    };
  }
  const failure = Cause.findErrorOption(exit.cause);
  if (Option.isSome(failure)) {
    return describeError(failure.value);
  }
  // A defect is a raw third-party throw: it gets a name from the classifier and
  // its text through the sanitizer, never onto the row unread.
  const defect = Cause.squash(exit.cause);
  const errorClass = classify({ thrown: defect });
  return {
    errorClass,
    errorMessage: clipError(defectMessage(defect)),
    outcome: outcomeOfClass(errorClass),
  };
};

/**
 * One provider invocation. The shared identity, economics, outcome and
 * environment vocabulary comes from the telemetry base; everything below it is
 * a question about the turn that the base cannot answer.
 *
 * `outcome` widens the base union by `no_terminal_event`, which is the failure
 * a silent provider produces and the one that disappears the moment it is
 * folded into `errored`.
 */
export const TurnEvent = defineEvent(TURN_EVENT_MARKER, {
  /** Whether the turn was pointed at an agent home at all — a turn with none has no transcript to find. */
  agentHomeSet: Schema.Boolean,
  assistantChars: Schema.Natural,
  assistantMessages: Schema.Natural,
  /** Reasoning effort asked for, where the provider takes one. */
  effort: Schema.NullOr(SanitizedText),
  errorEvents: Schema.Natural,
  eventsSeen: Schema.Natural,
  inputTokens: Schema.NullOr(Schema.Natural),
  /** What actually ran, which is the provider's choice and not always the request. */
  model: Schema.NullOr(SanitizedText),
  outcome: outcomeField(["no_terminal_event"]),
  outputTokens: Schema.NullOr(Schema.Natural),
  /** The prompt is measured, never carried. */
  promptChars: Schema.Natural,
  provider: SessionProvider,
  /** The provider's own conversation id, which is what a resume is pointed at. */
  providerSessionId: Schema.NullOr(SanitizedText),
  rateLimitPeakPct: Schema.NullOr(Schema.Number),
  rateLimitStatus: Schema.NullOr(RateLimitStatus),
  /** Which window the provider named — `5h`, `weekly`. The provider owns the wording. */
  rateLimitType: Schema.NullOr(SanitizedText),
  reasoningChars: Schema.Natural,
  /** Whether this turn continued an earlier session or started fresh. */
  resumed: Schema.Boolean,
  subagents: Schema.Natural,
  toolCalls: Schema.Natural,
  toolErrors: Schema.Natural,
});

/** The row one turn supplies, derived from the schema so it cannot drift. */
export type TurnEventInput = Parameters<typeof TurnEvent.encode>[0];

/** The immutable facts a provider knows before its turn starts. */
export interface TurnContext {
  /** True when the provider was pointed at this run's own agent home. */
  readonly agentHomeSet: boolean;
  /** The cell the provider folds its events into; read once, as the turn exits. */
  readonly counters: Ref.Ref<TurnCounters>;
  readonly effort: string | null;
  /** Resolved by {@link readTurnIdentity}, so the row joins the run that asked for it. */
  readonly identity: TurnIdentity;
  /** The model asked for. What the provider chose wins over it on the row. */
  readonly model: string | null;
  readonly promptChars: number;
  readonly provider: SessionProvider;
  /** True when a provider session id was handed in to continue. */
  readonly resumed: boolean;
}

/**
 * Builds the row from the three things that know about the turn: what was known
 * before it started, what it accumulated, and how it ended.
 *
 * Economics are the roll-up a completed turn produced, and they stay null on
 * every other outcome. An interrupted turn's last usage reading describes the
 * part of the work that happened, not the turn — storing it as the turn's cost
 * makes a killed run look cheap rather than unfinished.
 */
const turnRow = (
  context: TurnContext,
  counters: TurnCounters,
  wide: WideEventContext<unknown, HarnessError>
): TurnEventInput => {
  const ending = endingOf(wide.exit, counters);
  const complete = ending.outcome === "done";
  return {
    agentHomeSet: context.agentHomeSet,
    assistantChars: counters.assistantChars,
    assistantMessages: counters.assistantMessages,
    costUsd:
      complete && counters.costUsd !== null
        ? costUsdToNumber(counters.costUsd)
        : null,
    // Measured across every exit path, so it is real even where the economics
    // are not: an interrupted turn genuinely ran for that long.
    durationMs: wide.durationMs,
    effort: context.effort,
    errorClass: ending.errorClass,
    errorEvents: counters.errorEvents,
    errorMessage: ending.errorMessage,
    eventsSeen: counters.eventsSeen,
    inputTokens: complete ? counters.inputTokens : null,
    model: counters.model ?? context.model,
    outcome: ending.outcome,
    outputTokens: complete ? counters.outputTokens : null,
    // A turn is one row: the run's start row is the orchestrator's to write, and
    // it is the one that makes an in-flight turn queryable.
    phase: "end",
    promptChars: context.promptChars,
    provider: context.provider,
    providerSessionId: counters.providerSessionId,
    // The wait for a slot happened on the host, before the container existed.
    queueWaitMs: null,
    rateLimitPeakPct: counters.rateLimitPeakPct,
    rateLimitStatus: counters.rateLimitStatus,
    rateLimitType: counters.rateLimitType,
    reasoningChars: counters.reasoningChars,
    resumed: context.resumed,
    runId: context.identity.runId,
    sessionId: context.identity.sessionId,
    spanId: wide.spanId,
    subagents: counters.subagents,
    taskId: context.identity.taskId,
    toolCalls: counters.toolCalls,
    toolErrors: counters.toolErrors,
    totalTokens: complete ? totalTokensOf(counters) : null,
    traceId: wide.traceId,
    turns: complete ? counters.turns : null,
    workspaceId: context.identity.workspaceId,
  };
};

/**
 * Wraps one provider invocation so it leaves exactly one `atm.turn` row, on
 * every exit path — a clean finish, a typed failure, an SDK defect, and the
 * interrupt a stop command produces.
 *
 * The counters are read synchronously as the turn exits, from the cell the
 * provider folded its events into. That read is safe precisely there: the fiber
 * that wrote the cell has finished by the time the exit handler runs.
 *
 * @example
 * ```ts
 * const run = (options: RunOptions) =>
 *   Stream.callback<AgentEvent, HarnessError>((queue) =>
 *     Effect.gen(function* () {
 *       const counters = yield* makeTurnCounters;
 *       const identity = yield* readTurnIdentity({
 *         runId: options.runId,
 *         taskId: options.taskId,
 *       });
 *       const pump = Effect.gen(function* () {
 *         for (const event of yield* nextEvents) {
 *           yield* observeTurnEvent(counters, event);
 *           yield* Queue.offer(queue, event);
 *         }
 *       });
 *       return yield* pump.pipe(
 *         withTurnEvent({
 *           agentHomeSet: options.agentHomeDir.length > 0,
 *           counters,
 *           effort: options.effort,
 *           identity,
 *           model: options.model,
 *           promptChars: options.prompt.length,
 *           provider: "claude",
 *           resumed: options.resumeSessionId !== null,
 *         })
 *       );
 *     })
 *   );
 * ```
 */
export const withTurnEvent =
  (context: TurnContext) =>
  <A, R>(effect: Effect.Effect<A, HarnessError, R>) =>
    effect.pipe(
      withWideEvent(TurnEvent, (wide: WideEventContext<A, HarnessError>) =>
        turnRow(context, Ref.getUnsafe(context.counters), wide)
      )
    );
