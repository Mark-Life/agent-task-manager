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
 */

/** Which allowance window a signal is about. `reactive` is a drained run, not a read. */
export const QUOTA_WINDOWS = ["primary", "secondary", "reactive"] as const;

/** The rolling windows a provider reports, plus the one a failed run implies. */
export type QuotaWindow = (typeof QUOTA_WINDOWS)[number];

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
export interface WindowUsage {
  readonly resetsAtMs: number | null;
  readonly utilizationPercent: number;
  readonly windowSeconds: number | null;
}

/** One read of a provider's allowance. */
export interface ProviderUsage {
  /** False means the read produced no usable signal, which is not the same as drained. */
  readonly available: boolean;
  /** The provider itself says it is out. The one hard signal. */
  readonly limitReached: boolean;
  /** The short rolling window, ~5h on both providers. Null when the source omits it. */
  readonly primary: WindowUsage | null;
  /** Which window the provider named as reached, where it names one. */
  readonly reachedWindow: QuotaWindow | null;
  /** The long rolling window, ~7 days. Null when the source omits it. */
  readonly secondary: WindowUsage | null;
}

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
