/**
 * What one agent session spent, as everything outside the harness reads it.
 *
 * The question this answers is not "what is left in the subscription" — that is
 * `./provider-usage`, published by the loop from a rolling allowance window.
 * This is per-session accounting, read out of the transcript the provider wrote:
 * how much of the model's context window the conversation is occupying, how it
 * got there, what it would have cost on the API, and which tools did the work.
 *
 * The shape lives here because the writer and the readers are in different
 * packages and none of them may own it: the orchestrator derives it from the
 * transcript, the store keeps it, the gateway serves it, the dashboard draws it.
 *
 * **Every figure is either reported or absent.** A provider that never wrote a
 * number leaves null, and null renders as unavailable rather than as zero —
 * "this session used no cache" and "this provider does not say" are different
 * facts and a zero merges them. The one derived figure is
 * {@link SessionUsage.cost}, which is worked out from `./model-price` and
 * carries the table that produced it so the UI can say so.
 *
 * **The window is marked with where it came from.** Codex writes
 * `model_context_window` into its own rollout, so its denominator is reported.
 * Claude writes nothing of the kind and its window is inferred from the model
 * id, which is a lookup that can be wrong — and a percentage against a wrong
 * denominator is the one number here that would send someone to start a fresh
 * session for no reason.
 */

import { Schema } from "effect";
import { SessionProvider } from "./enums";
import { AgentSessionId, WorkspaceId } from "./ids";
import { CostUsd } from "./primitives";

/**
 * The one instant in this file, and the one place it is not `./primitives`'
 * {@link Timestamp}.
 *
 * That one is `DateTimeUtcFromDate`, which is right for a `timestamptz` column
 * the driver hands back as a `Date`. This whole summary is stored inside a
 * `jsonb` blob and sent as JSON, and neither of those has a `Date` — a stamp
 * encoded as one comes back a string and fails to decode. So it is a string on
 * the wire and in the column, and a `DateTime.Utc` everywhere it is reasoned
 * about, exactly like every other instant in the domain.
 */
const StoredInstant = Schema.DateTimeUtcFromString;

/**
 * Where the context window a percentage is measured against came from.
 *
 * `reported` is the provider's own figure, written into the transcript.
 * `inferred` is our lookup by model id, and it is the reason the UI says so
 * beside the number.
 */
export const CONTEXT_WINDOW_SOURCES = ["inferred", "reported"] as const;

export const ContextWindowSource = Schema.Literals(CONTEXT_WINDOW_SOURCES);
export type ContextWindowSource = typeof ContextWindowSource.Type;

/**
 * One request's reading, in the order the provider made them. This is the
 * growth curve: `contextTokens` is what the prompt occupied on that request, so
 * the series is how the conversation filled its window.
 */
export const UsagePoint = Schema.Struct({
  cacheReadTokens: Schema.NullOr(Schema.Natural),
  /** What the prompt occupied: fresh input plus everything read from or written to cache. */
  contextTokens: Schema.Natural,
  /** Fresh prompt tokens — what neither cache covered. */
  inputTokens: Schema.NullOr(Schema.Natural),
  /** The provider's own stamp, verbatim. Null on the readings that carry none. */
  occurredAt: Schema.NullOr(Schema.String),
  outputTokens: Schema.NullOr(Schema.Natural),
}).annotate({ identifier: "UsagePoint" });

export interface UsagePoint extends Schema.Schema.Type<typeof UsagePoint> {}

/**
 * The session's totals, each null where the provider never reported that kind.
 *
 * Input is counted fresh — Codex's `input_tokens` includes what it read from
 * cache and Claude's does not, so the two are normalized to the same meaning
 * before they get here. Without that, one provider's input total silently
 * double-counts its cache.
 */
export const SessionTokenTotals = Schema.Struct({
  cacheReadTokens: Schema.NullOr(Schema.Natural),
  /** Tokens written into the prompt cache. Claude reports this; the Responses API has no such figure. */
  cacheWriteTokens: Schema.NullOr(Schema.Natural),
  inputTokens: Schema.NullOr(Schema.Natural),
  outputTokens: Schema.NullOr(Schema.Natural),
  /** The thinking half of output, where the provider separates it. Claude folds it into `outputTokens`. */
  reasoningOutputTokens: Schema.NullOr(Schema.Natural),
}).annotate({ identifier: "SessionTokenTotals" });

export interface SessionTokenTotals
  extends Schema.Schema.Type<typeof SessionTokenTotals> {}

/** How often one tool was called, and how often it came back an error. */
export const ToolCallCount = Schema.Struct({
  calls: Schema.Natural,
  /** Results the provider marked failed. A provider that does not say contributes nothing here. */
  errors: Schema.Natural,
  name: Schema.String,
}).annotate({ identifier: "ToolCallCount" });

export interface ToolCallCount
  extends Schema.Schema.Type<typeof ToolCallCount> {}

/**
 * One of the largest things in the conversation, measured in characters.
 *
 * Characters and not tokens, deliberately. Sizing an item in tokens means
 * dividing by four, and a made-up token count sitting next to the provider's
 * real ones is exactly the confusion the rest of this file exists to prevent.
 * A reader ranking what filled the window does not need the unit to be tokens.
 */
export const LargestEntry = Schema.Struct({
  chars: Schema.Natural,
  /** The 0-based line of the transcript file it came from. */
  line: Schema.Natural,
  /** The transcript reader's role vocabulary: `tool_result`, `user`, and so on. */
  role: Schema.String,
  toolName: Schema.NullOr(Schema.String),
}).annotate({ identifier: "LargestEntry" });

export interface LargestEntry extends Schema.Schema.Type<typeof LargestEntry> {}

/**
 * What the session would have cost on the API, and everything a reader needs to
 * distrust it appropriately.
 *
 * Never presented without the word "estimate". Subscription runs are not billed
 * per token at all, the table is dated, and a session that used a model the
 * table has never heard of reports a total that is a floor —
 * `unpricedRequests` is how a reader knows which of those they are looking at.
 */
export const SessionCost = Schema.Struct({
  /** Requests the table had a rate for. The total covers exactly these. */
  pricedRequests: Schema.Natural,
  /** The day the rates were read off the vendors' pricing pages. */
  priceTableEffective: Schema.String,
  priceTableVersion: Schema.Natural,
  totalUsd: CostUsd,
  /** Model ids the table has no rate for, so a reader can say what is missing. */
  unpricedModels: Schema.Array(Schema.String),
  /** Requests left out of the total. Above zero, the total is a floor. */
  unpricedRequests: Schema.Natural,
}).annotate({ identifier: "SessionCost" });

export interface SessionCost extends Schema.Schema.Type<typeof SessionCost> {}

/**
 * Everything one session's transcript says about what it spent.
 *
 * Derived, stored, and served whole. It is recomputed from the file at the end
 * of every run on the session, so it grows with the conversation and outlives
 * the file: a transcript cleaned up off the disk leaves the last summary
 * standing, which is the point of storing it rather than reading on demand.
 */
export const SessionUsage = Schema.Struct({
  /** When this summary was derived — not when the session ran. A running session's is one run old. */
  computedAt: StoredInstant,
  /** The denominator a percentage is measured against. Null where no model id was priceable to a window. */
  contextWindow: Schema.NullOr(Schema.Natural),
  /** Null exactly when `contextWindow` is. Read it before rendering the percentage as fact. */
  contextWindowSource: Schema.NullOr(ContextWindowSource),
  /** Null when nothing in the session could be priced at all. */
  cost: Schema.NullOr(SessionCost),
  /** Transcript entries the summary was computed over: how much conversation it saw. */
  entries: Schema.Natural,
  /** The last reading, which is what a resumed session starts from. */
  finalContextTokens: Schema.NullOr(Schema.Natural),
  /** The context curve, oldest first. */
  growth: Schema.Array(UsagePoint),
  /** True when the curve was thinned to fit the stored point limit; the peak and the ends are always kept. */
  growthSampled: Schema.Boolean,
  largestEntries: Schema.Array(LargestEntry),
  /** Every model id the session used, in the order first seen. */
  models: Schema.Array(Schema.String),
  /** The high-water mark. Null when the provider reported no usage at all. */
  peakContextTokens: Schema.NullOr(Schema.Natural),
  provider: SessionProvider,
  /** Model requests the transcript recorded. Not turns, and not messages. */
  requests: Schema.Natural,
  toolCalls: Schema.Array(ToolCallCount),
  totals: SessionTokenTotals,
}).annotate({ identifier: "SessionUsage" });

export interface SessionUsage extends Schema.Schema.Type<typeof SessionUsage> {}

/**
 * The JSON form: what the `jsonb` column actually holds and what crosses the
 * wire. Named because a column has to be typed with it — a column typed with
 * the decoded shape claims to store a `DateTime.Utc`, which no database does.
 */
export type StoredSessionUsage = typeof SessionUsage.Encoded;

/**
 * One session's summary as the store holds it: the figures, and which session
 * and workspace they belong to.
 *
 * A row of its own rather than a column on the session, because the curve is
 * kilobytes and a session list should not pay for a chart nobody has opened.
 */
export const AgentSessionUsage = Schema.Struct({
  sessionId: AgentSessionId,
  usage: SessionUsage,
  workspaceId: WorkspaceId,
}).annotate({ identifier: "AgentSessionUsage" });

export interface AgentSessionUsage
  extends Schema.Schema.Type<typeof AgentSessionUsage> {}

/**
 * How full the window is, 0–1, or null where either half is unknown.
 *
 * One implementation because the bar, the tooltip and the accessible name are
 * three renderings of one number, and a percentage worked out twice is a
 * percentage that will eventually disagree with itself.
 */
export const contextFractionOf = (usage: SessionUsage) => {
  const { contextWindow, peakContextTokens } = usage;
  if (
    contextWindow === null ||
    contextWindow === 0 ||
    peakContextTokens === null
  ) {
    return null;
  }
  return Math.min(1, peakContextTokens / contextWindow);
};
