/**
 * The gate's own state, turned into the document everything outside this
 * process reads.
 *
 * Pure, apart from the write at the bottom. The gate holds the numbers because
 * it needs them to decide; this file is the part that says them out loud, and
 * keeping the translation here rather than inside the gate is what stops the
 * decision and the display drifting into two different readings of one cache.
 *
 * Two things are decided here rather than by whoever renders it.
 *
 * **Remaining, not used.** The question a person asks is how much is left, so
 * that is the number published; `usedPercent` rides along because the provider
 * reports it and a reader comparing against a threshold wants it in the same
 * units it was set in. Both are clamped to 0–100 — a provider that reports 103%
 * of a window spent is reporting overflow, not a tank with negative fuel in it.
 *
 * **The window is labelled from what the provider said.** `windowSeconds` comes
 * off the response, and the label is derived from it, so a provider that
 * shortens a window relabels the figure instead of leaving a hardcoded "5h"
 * describing something else.
 */

import { join } from "node:path";
import {
  PROVIDER_USAGE_FILE,
  type ProviderUsageReport,
  ProviderUsageSnapshot,
  type ProviderUsageState,
  type SessionProvider,
  USAGE_PERCENT_MAX,
  type UsageWindow,
  type UsageWindowKind,
} from "@workspace/domain";
import { DateTime, Effect, Schema } from "effect";
import type { FileSystem } from "effect/FileSystem";
import type { ProviderUsage, WindowUsage } from "./types";

/** Divisors for the label, largest first: a week reads as `7d`, not as `168h`. */
const DAY_SECONDS = 86_400;
const HOUR_SECONDS = 3600;
const MINUTE_SECONDS = 60;

/** The floor of a percentage, the other end of {@link USAGE_PERCENT_MAX}. */
const USAGE_PERCENT_MIN = 0;

const clampPercent = (value: number) =>
  Math.min(USAGE_PERCENT_MAX, Math.max(USAGE_PERCENT_MIN, value));

/**
 * How a span reads to a person. Whole units only, because every window either
 * provider reports is a whole number of hours or days, and a `4.99h` in the one
 * case that is not would be worse than the raw seconds.
 *
 * A span the provider did not state is labelled by role rather than invented.
 */
const windowLabel = (input: {
  readonly kind: UsageWindowKind;
  readonly windowSeconds: number | null;
}) => {
  const seconds = input.windowSeconds;
  if (seconds === null || seconds <= 0) {
    return input.kind === "primary" ? "short window" : "long window";
  }
  if (seconds % DAY_SECONDS === 0) {
    return `${seconds / DAY_SECONDS}d`;
  }
  if (seconds % HOUR_SECONDS === 0) {
    return `${seconds / HOUR_SECONDS}h`;
  }
  if (seconds % MINUTE_SECONDS === 0) {
    return `${seconds / MINUTE_SECONDS}m`;
  }
  return `${seconds}s`;
};

/** One window of a reading, as the document carries it. */
const publishedWindow = (input: {
  readonly kind: UsageWindowKind;
  readonly usage: WindowUsage;
}): UsageWindow => {
  const usedPercent = clampPercent(input.usage.utilizationPercent);
  return {
    kind: input.kind,
    label: windowLabel({
      kind: input.kind,
      windowSeconds: input.usage.windowSeconds,
    }),
    remainingPercent: USAGE_PERCENT_MAX - usedPercent,
    resetsAt:
      input.usage.resetsAtMs === null
        ? null
        : DateTime.makeUnsafe(input.usage.resetsAtMs),
    usedPercent,
    windowSeconds: input.usage.windowSeconds,
  };
};

/** What the gate knows about one provider at the moment of publishing. */
export interface ProviderReading {
  /** Whether a drained reading on this provider would actually hold a dispatch back. */
  readonly enforced: boolean;
  /** When the reactive pause lifts, where one is in force. */
  readonly pausedUntilMs: number | null;
  /** The reason on the pause record, where one is in force. */
  readonly pauseReason: string | null;
  readonly provider: SessionProvider;
  /** When the cached usage below was read. Null before the first read. */
  readonly readAtMs: number | null;
  /** Whether the poller is switched on at all — the one honest reason for a blank. */
  readonly reading: boolean;
  readonly usage: ProviderUsage;
}

/**
 * Why a provider is in the state it is, in a sentence.
 *
 * Every string here is assembled from literals. Nothing a provider sent is
 * quoted into it: this document is read by a browser, and the pause reason —
 * the one field with any history — is built the same way inside the gate.
 */
const noteOf = (input: ProviderReading, state: ProviderUsageState) => {
  if (state === "paused") {
    return input.pauseReason;
  }
  if (state === "limit_reached") {
    return "the provider reports its limit reached";
  }
  if (state === "unavailable") {
    return input.reading
      ? "the last read produced no signal — runs dispatch without it"
      : "usage reads are switched off";
  }
  return null;
};

/**
 * Where a provider stands, in the order the gate itself decides things: a live
 * pause is a confirmed drain and outranks a cached reading, a reading we could
 * not take is *unavailable* rather than empty, and only then do the numbers
 * speak.
 */
const stateOf = (input: ProviderReading): ProviderUsageState => {
  if (input.pausedUntilMs !== null) {
    return "paused";
  }
  if (!input.usage.available) {
    return "unavailable";
  }
  return input.usage.limitReached ? "limit_reached" : "ok";
};

/** One provider's tank, published. */
export const providerReport = (input: ProviderReading): ProviderUsageReport => {
  const state = stateOf(input);
  const windows: UsageWindow[] = [];
  if (input.usage.primary !== null) {
    windows.push(
      publishedWindow({ kind: "primary", usage: input.usage.primary })
    );
  }
  if (input.usage.secondary !== null) {
    windows.push(
      publishedWindow({ kind: "secondary", usage: input.usage.secondary })
    );
  }
  return {
    enforced: input.enforced,
    note: noteOf(input, state),
    pausedUntil:
      input.pausedUntilMs === null
        ? null
        : DateTime.makeUnsafe(input.pausedUntilMs),
    provider: input.provider,
    readAt:
      input.readAtMs === null ? null : DateTime.makeUnsafe(input.readAtMs),
    state,
    windows,
  };
};

/** Every governed provider, plus the moment this was assembled. */
export const usageSnapshot = (input: {
  readonly nowMs: number;
  readonly readings: readonly ProviderReading[];
}): ProviderUsageSnapshot => ({
  providers: input.readings.map(providerReport),
  publishedAt: DateTime.makeUnsafe(input.nowMs),
});

const encodeSnapshot = Schema.encodeEffect(ProviderUsageSnapshot);

/** Where the loop leaves its last reading. */
export const usagePathOf = (stateDir: string) =>
  join(stateDir, PROVIDER_USAGE_FILE);

/**
 * Writes the document where the gateway will find it, through a temporary file
 * for the same reason the pause record is: a reader that opened a half-written
 * file would decode nothing and render "never published", which is a worse
 * answer than the previous reading.
 *
 * Best effort by construction. A dashboard that cannot show the tanks is a
 * degraded dashboard; a dispatch that failed because it could not write a file
 * about the dispatch would be a broken factory.
 */
export const publishUsage = (input: {
  readonly fs: FileSystem;
  readonly snapshot: ProviderUsageSnapshot;
  readonly stateDir: string;
}) =>
  Effect.gen(function* () {
    const encoded = yield* encodeSnapshot(input.snapshot);
    const path = usagePathOf(input.stateDir);
    yield* input.fs.makeDirectory(input.stateDir, { recursive: true });
    const temporary = `${path}.${process.pid}.tmp`;
    yield* input.fs.writeFileString(
      temporary,
      JSON.stringify(encoded, null, 2)
    );
    yield* input.fs.rename(temporary, path);
  }).pipe(Effect.ignoreCause);
