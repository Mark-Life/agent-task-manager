/**
 * What is left in a provider's subscription, as everything outside the loop
 * reads it.
 *
 * The loop is the only process that can answer this: the credentials live in
 * the agent home it owns, and the gate in front of dispatch is already holding
 * the answer in a cache. So the loop publishes one small document under the
 * data root and the gateway serves it, rather than a second process learning to
 * read two undocumented endpoints and racing the first one for the same
 * allowance. That is why the shape lives here — the writer and the reader are
 * in different packages and neither may own it.
 *
 * Three things are said about every figure, because a percentage on its own is
 * unreadable. **Which window it belongs to**, since a 5-hour window at 80% and a
 * weekly window at 80% mean different things to whoever is deciding whether to
 * start something. **When it was read**, since the reading is cached and a
 * number with no age behind it looks live when it is not. **Whether it can
 * actually hold a run back**, since a system that is only watching and a system
 * that is enforcing look identical in a number.
 *
 * `state` is a closed set rather than a pair of booleans, because the state that
 * matters most — "we could not tell" — is not "0% used" and not "drained", and a
 * flag bag lets a reader render it as either.
 */

import { Schema } from "effect";
import { SessionProvider } from "./enums";

/** Directory under the data root the quota gate keeps its state in. */
export const QUOTA_SEGMENT = "quota";

/**
 * The published reading's filename inside that directory. Spelled once here
 * rather than in the loop that writes it and again in the gateway that reads
 * it, which is the pair that would otherwise drift into a permanently empty
 * dashboard nobody can explain.
 */
export const PROVIDER_USAGE_FILE = "usage.json";

/** The full and empty ends of a window, and the range a percentage is clamped to. */
export const USAGE_PERCENT_MAX = 100;

/** Which allowance window a figure belongs to. Both providers report these two. */
export const USAGE_WINDOWS = ["primary", "secondary"] as const;

/**
 * The short rolling window against the long one. Named by role rather than by
 * duration because the durations are the provider's to change, and
 * {@link UsageWindow} carries the length it actually reported.
 */
export const UsageWindowKind = Schema.Literals(USAGE_WINDOWS);
export type UsageWindowKind = typeof UsageWindowKind.Type;

/**
 * One window's reading.
 *
 * `label` and `windowSeconds` both describe the same span and are both here on
 * purpose: the label is what a person reads, and the seconds are what a machine
 * compares. Both come off the provider's own response where it states them —
 * Codex names `limit_window_seconds`, Claude names its windows `five_hour` and
 * `seven_day` — so a provider that changes a window's length changes the label
 * with it rather than leaving a hardcoded "5h" lying about a 3-hour window.
 *
 * `resetsAt` is null wherever the source omitted it. An invented reset is worse
 * than none: it is the time a reader would plan around.
 */
export const UsageWindow = Schema.Struct({
  kind: UsageWindowKind,
  /** Human label for the span, e.g. `5h` or `7d`, derived from what the provider reported. */
  label: Schema.String,
  /** How much of the window is still available, 0–100. The number the ask is about. */
  remainingPercent: Schema.Number,
  resetsAt: Schema.NullOr(Schema.DateTimeUtcFromString),
  usedPercent: Schema.Number,
  /** The span's length in seconds, where the provider states it. */
  windowSeconds: Schema.NullOr(Schema.Int),
}).annotate({ identifier: "UsageWindow" });

export interface UsageWindow extends Schema.Schema.Type<typeof UsageWindow> {}

/**
 * Where a provider stands.
 *
 * `unavailable` is the one worth being careful about: it means the read
 * produced no signal — no credentials on the host, an expired token, a body
 * whose shape moved — and the gate is dispatching blind. It is deliberately not
 * the same value as `ok`, because the two look identical on a dashboard that
 * only renders percentages and they are opposite facts.
 */
export const PROVIDER_USAGE_STATES = [
  "ok",
  "limit_reached",
  "paused",
  "unavailable",
] as const;

export const ProviderUsageState = Schema.Literals(PROVIDER_USAGE_STATES);
export type ProviderUsageState = typeof ProviderUsageState.Type;

/** One provider's tank, as the last read left it. */
export const ProviderUsageReport = Schema.Struct({
  /**
   * Whether this provider's numbers may actually hold a dispatch back. False is
   * the watching-only state, and a reading nobody acts on is worth saying out
   * loud rather than implying.
   */
  enforced: Schema.Boolean,
  /** Why the state is what it is, in one sentence, where there is anything to say. */
  note: Schema.NullOr(Schema.String),
  /** When a reactive pause lifts, where one is in force. */
  pausedUntil: Schema.NullOr(Schema.DateTimeUtcFromString),
  provider: SessionProvider,
  /** When the figures below were read. Null where nothing has been read yet. */
  readAt: Schema.NullOr(Schema.DateTimeUtcFromString),
  state: ProviderUsageState,
  /** Empty where the read produced no signal — never a zeroed window, which reads as full. */
  windows: Schema.Array(UsageWindow),
}).annotate({ identifier: "ProviderUsageReport" });

export interface ProviderUsageReport
  extends Schema.Schema.Type<typeof ProviderUsageReport> {}

/**
 * Every governed provider in one document, plus when the document was written.
 *
 * `publishedAt` is null and `providers` empty in exactly one case: the loop has
 * not published yet — it is not running, or it has not completed a pass since
 * it started. That is a state a reader should be able to tell from "both
 * providers read fine and are empty", which an empty list says and a list of
 * zeroed reports would not.
 */
export const ProviderUsageSnapshot = Schema.Struct({
  providers: Schema.Array(ProviderUsageReport),
  publishedAt: Schema.NullOr(Schema.DateTimeUtcFromString),
}).annotate({ identifier: "ProviderUsageSnapshot" });

export interface ProviderUsageSnapshot
  extends Schema.Schema.Type<typeof ProviderUsageSnapshot> {}

/** What the gateway answers before the loop has ever published. */
export const EMPTY_USAGE_SNAPSHOT: ProviderUsageSnapshot = {
  providers: [],
  publishedAt: null,
};
