/**
 * Reading a drained subscription out of a run that already failed. The
 * safety floor under the proactive read, and the only signal Codex gives at all.
 *
 * The two providers say it differently. Claude emits a structured rate-limit
 * reading — `@workspace/harness` normalizes it onto the `usage` event as
 * `rateLimitStatus` — so there is nothing to guess: `rejected` is the provider
 * refusing to serve, and that is a drain. Codex emits no such field; a drained
 * run surfaces as a generic error whose message has to be read for meaning, and
 * the orchestrator has already clipped that message to one line by the time it
 * gets here.
 *
 * So the text matcher is anchored and short, and it is guarded. "Context
 * length", "token limit" and a tool's own rate limit all contain a drain-ish
 * word and are a different failure entirely — pausing a healthy provider on one
 * of those idles the whole pool for nothing, while missing a real drain costs
 * one more errored run and is caught by the next signal. Conservative in that
 * direction on purpose.
 *
 * The wording belongs to the upstream `codex` binary and drifts across
 * versions, which is what {@link looksRateLimitShaped} exists for: an error that
 * smells like a rate limit and matched no anchor is a countable canary, so the
 * matcher rotting is something an operator sees rather than something that
 * quietly stops detecting drains.
 */

import type { RateLimitStatus } from "@workspace/harness";

/**
 * Phrases that confidently name a subscription drain. Short and specific, and
 * matched lower-cased against a lower-cased message.
 */
const DRAIN_ANCHORS: readonly string[] = [
  "usage limit",
  "rate limit",
  "rate_limit",
  "too many requests",
  "429",
  "quota",
];

/**
 * Phrases carrying a drain-ish word that name a different failure. Any of them
 * vetoes a match — this is the false-positive guard, and it is the reason the
 * matcher can be as broad as `429` above without idling the pool.
 */
const FALSE_POSITIVE_GUARDS: readonly string[] = [
  "context length",
  "context window",
  "maximum context",
  "token limit",
  "tool call limit",
  "rate limited by tool",
  "policy",
  "content limit",
  "character limit",
  "size limit",
];

/** Broader words that make an unmatched error rate-limit-shaped, and so a canary. */
const SHAPED_KEYWORDS: readonly string[] = [
  "limit",
  "quota",
  "exhausted",
  "throttl",
  "429",
];

const hasGuard = (message: string) =>
  FALSE_POSITIVE_GUARDS.some((guard) => message.includes(guard));

/**
 * Whether this error text is confidently a Codex subscription drain: an anchor
 * is present and no guard vetoes it.
 */
export const detectUsageLimitText = (message: string) => {
  if (message.length === 0) {
    return false;
  }
  const text = message.toLowerCase();
  if (hasGuard(text)) {
    return false;
  }
  return DRAIN_ANCHORS.some((anchor) => text.includes(anchor));
};

/**
 * Whether an error looked like a rate limit but matched nothing. Only the
 * ambiguous middle answers true — a confident match and an unrelated failure
 * both answer false — so the count is exactly "how often did the matcher have an
 * opinion it could not form", which is the number that says the wording moved.
 */
export const looksRateLimitShaped = (message: string) => {
  if (message.length === 0 || detectUsageLimitText(message)) {
    return false;
  }
  const text = message.toLowerCase();
  return SHAPED_KEYWORDS.some((keyword) => text.includes(keyword));
};

/**
 * Whether the harness's structured reading is a drain. `rejected` is the
 * provider declining to serve the request; `allowed_warning` is the reading
 * worth having and deliberately does not pause — it arrives *before* runs start
 * failing, and pausing on a warning would idle the pool at the moment the
 * remaining allowance is still worth spending.
 */
export const detectRateLimitStatus = (status: RateLimitStatus | null) =>
  status === "rejected";
