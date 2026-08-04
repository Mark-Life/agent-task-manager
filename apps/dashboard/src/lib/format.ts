import { type CostUsd, costUsdToNumber } from "@workspace/domain";
import { DateTime } from "effect";

const SECOND = 1000;
const MINUTE = 60_000;
const HOUR = 3_600_000;
const DAY = 86_400_000;
const WEEK = 604_800_000;

/** Below this, "just now" is truer than a number that changes as you read it. */
const JUST_NOW = 45_000;

const THOUSAND = 1000;
const MILLION = 1_000_000;

/** The smallest cost the two-decimal display can tell apart from nothing. */
const CENT = 0.01;

/** How an instant is written when it is old enough that "5d ago" stops helping. */
const ABSOLUTE_DEFAULTS = {
  dateStyle: "medium",
  timeStyle: "short",
} as const satisfies Intl.DateTimeFormatOptions;

type FormatOptions = Intl.DateTimeFormatOptions & {
  readonly locale?: string;
};

/**
 * An instant in the operator's own zone and locale.
 *
 * Decoded timestamps are `DateTime.Utc`, so the conversion to local time has to
 * happen here rather than being assumed of the string — the value never was a
 * string. Options are open so a caller can drop the time from a date-only
 * column, and so tests can pin a zone.
 */
export const formatAbsolute = (when: DateTime.Utc, options?: FormatOptions) =>
  DateTime.formatLocal(when, { ...ABSOLUTE_DEFAULTS, ...options });

/**
 * How long ago something happened, in the compact form a dense board needs.
 *
 * Units are single letters and never pluralised, which keeps a card's metadata
 * line from reflowing as a run ages. Past about a week the distance stops
 * meaning anything, so it hands over to the absolute date. `now` is a parameter
 * rather than a call inside, so the function is pure and testable.
 */
export const formatRelative = (
  when: DateTime.Utc,
  now: DateTime.Utc = DateTime.nowUnsafe()
) => {
  const delta = DateTime.toEpochMillis(now) - DateTime.toEpochMillis(when);
  const magnitude = Math.abs(delta);

  if (magnitude < JUST_NOW) {
    return "just now";
  }
  if (magnitude >= WEEK) {
    return formatAbsolute(when, { timeStyle: undefined });
  }

  const value = unitOf(magnitude);
  return delta > 0 ? `${value} ago` : `in ${value}`;
};

/** The largest unit that still leaves a number worth reading. */
const unitOf = (magnitude: number) => {
  if (magnitude < HOUR) {
    return `${Math.floor(magnitude / MINUTE)}m`;
  }
  if (magnitude < DAY) {
    return `${Math.floor(magnitude / HOUR)}h`;
  }
  return `${Math.floor(magnitude / DAY)}d`;
};

/**
 * A run's wall time, from milliseconds.
 *
 * Null in, null out: a run that never reported a duration has none, and a
 * rendered "0ms" would be a measurement nobody took. Precision drops as the
 * magnitude grows, because nobody reads the seconds off a two-hour run.
 */
export const formatDuration = (ms: number | null | undefined) => {
  if (ms === null || ms === undefined) {
    return null;
  }
  if (ms < SECOND) {
    return `${Math.round(ms)}ms`;
  }
  if (ms < MINUTE) {
    return `${(ms / SECOND).toFixed(1)}s`;
  }
  if (ms < HOUR) {
    return `${Math.floor(ms / MINUTE)}m ${Math.floor((ms % MINUTE) / SECOND)}s`;
  }
  return `${Math.floor(ms / HOUR)}h ${Math.floor((ms % HOUR) / MINUTE)}m`;
};

/**
 * A token count, abbreviated.
 *
 * Exact below a thousand, then one decimal place — the difference between
 * 41.2k and 41.3k tokens never changed a decision, and the full digits crowd
 * out the numbers that did. Null in, null out, for the same reason durations
 * are.
 */
export const formatTokens = (count: number | null | undefined) => {
  if (count === null || count === undefined) {
    return null;
  }
  if (count < THOUSAND) {
    return String(Math.round(count));
  }
  if (count < MILLION) {
    return `${trimZero(count / THOUSAND)}k`;
  }
  return `${trimZero(count / MILLION)}M`;
};

/** One decimal, but not a decimal that says nothing: 41.0k reads as 41k. */
const trimZero = (value: number) => {
  const fixed = value.toFixed(1);
  return fixed.endsWith(".0") ? fixed.slice(0, -2) : fixed;
};

/**
 * What a run cost, in dollars.
 *
 * Null in, null out, and callers must render the null as nothing at all. A
 * degraded run reports no cost; printing `$0` for it invents a measurement and
 * anyone who later sums the column gets a number that is quietly wrong. A real
 * cost too small for two decimals is shown as a bound rather than rounded down
 * to the same lie.
 */
export const formatCost = (cost: CostUsd | null | undefined) => {
  if (cost === null || cost === undefined) {
    return null;
  }
  const value = costUsdToNumber(cost);
  if (value > 0 && value < CENT) {
    return "<$0.01";
  }
  return `$${value.toFixed(2)}`;
};
