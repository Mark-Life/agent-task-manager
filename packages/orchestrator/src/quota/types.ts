/**
 * What a provider's subscription allowance looks like to the gate, independent
 * of how it was read.
 *
 * One shape for two very different sources — Codex's nested `wham/usage` body
 * and Claude's flat OAuth one — because the decision is the same either way: how
 * full is the window, when does it roll over, and did the provider already say
 * it is out. Keeping that shape here rather than in either reader is what lets a
 * third source, or a reactive-only provider with no source at all, arrive
 * without touching the gate.
 *
 * `available` is the load-bearing field. It is the difference between "the
 * provider is drained" and "we could not tell", and the two have opposite safe
 * answers: a confident drain defers, and an unreadable signal dispatches with an
 * alert. A gate that silently disables itself is worse than no gate, because the
 * operator believes it is on.
 *
 * These are schemas rather than bare interfaces because the last good reading is
 * written to disk and read back after a restart — see `./readings`. A hand-kept
 * second spelling of this shape would drift the moment a field is added here,
 * and it would drift silently, into a panel showing figures nobody can explain.
 */

import { Schema } from "effect";

/** Which allowance window a signal is about. `reactive` is a drained run, not a read. */
export const QUOTA_WINDOWS = ["primary", "secondary", "reactive"] as const;

/** The rolling windows a provider reports, plus the one a failed run implies. */
export const QuotaWindow = Schema.Literals(QUOTA_WINDOWS);
export type QuotaWindow = typeof QuotaWindow.Type;

/**
 * How full one window is. `utilizationPercent` is normalized to 0–100 by the
 * reader, so nothing downstream has to remember which source reports a fraction.
 * `resetsAtMs` is null where the source omitted it — an invented reset would
 * hold the pool closed past the real one.
 *
 * `windowSeconds` is how long the window is, as the provider stated it. It is
 * carried rather than assumed because it is what labels the figure for whoever
 * reads it, and a label the provider did not say is a label that goes stale
 * silently: Codex names the length on every window it reports, and Claude names
 * it in the key. Null where a source states neither.
 */
export const WindowUsage = Schema.Struct({
  resetsAtMs: Schema.NullOr(Schema.Number),
  utilizationPercent: Schema.Number,
  windowSeconds: Schema.NullOr(Schema.Number),
}).annotate({ identifier: "WindowUsage" });

export interface WindowUsage extends Schema.Schema.Type<typeof WindowUsage> {}

/** One read of a provider's allowance. */
export const ProviderUsage = Schema.Struct({
  /** False means the read produced no usable signal, which is not the same as drained. */
  available: Schema.Boolean,
  /** The provider itself says it is out. The one hard signal. */
  limitReached: Schema.Boolean,
  /** The short rolling window, ~5h on both providers. Null when the source omits it. */
  primary: Schema.NullOr(WindowUsage),
  /** Which window the provider named as reached, where it names one. */
  reachedWindow: Schema.NullOr(QuotaWindow),
  /** The long rolling window, ~7 days. Null when the source omits it. */
  secondary: Schema.NullOr(WindowUsage),
}).annotate({ identifier: "ProviderUsage" });

export interface ProviderUsage
  extends Schema.Schema.Type<typeof ProviderUsage> {}

/**
 * The unreadable shape. Every failure path collapses to this, and so does a
 * provider with the proactive read switched off — in both cases the gate has
 * nothing to go on and admits.
 */
export const UNAVAILABLE_USAGE: ProviderUsage = {
  available: false,
  limitReached: false,
  primary: null,
  reachedWindow: null,
  secondary: null,
};

/** The gate let this dispatch through. */
export interface QuotaAdmitted {
  readonly defer: false;
}

/**
 * The gate held this dispatch back. `loud` marks the long drain — days of idle
 * rather than hours — which is the one worth telling a human about on the task
 * itself; the short window logs and counts and stays quiet.
 */
export interface QuotaDeferred {
  readonly defer: true;
  readonly loud: boolean;
  /** Sanitized-by-construction: assembled here from numbers and literals, never from a provider's text. */
  readonly reason: string;
  /** Unix milliseconds dispatch may resume, or null where nothing said when. */
  readonly resumesAtMs: number | null;
  readonly window: QuotaWindow;
}

/** What the gate answers per dispatch. */
export type QuotaDecision = QuotaAdmitted | QuotaDeferred;

/** The admit answer. One value, so an admit cannot carry a stale reason. */
export const ADMIT: QuotaDecision = { defer: false };
