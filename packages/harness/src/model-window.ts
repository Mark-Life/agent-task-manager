/**
 * How big a model's context window is, for the provider that does not say.
 *
 * Codex writes `model_context_window` into every `token_count`, so its
 * denominator is a fact. Claude writes nothing of the kind, and "42% of the
 * window" is the number this whole feature exists to show — so the window is
 * looked up by model id here, and the answer is marked `inferred` all the way
 * to the screen.
 *
 * **Exact ids, not family substrings.** A substring match is how a 200k model
 * quietly gets a 1M denominator and a session that is nearly full reads as
 * comfortable. The only normalization is the one the price table applies: a
 * release date stripped, dots folded to hyphens. An id nobody listed has no
 * window, and the percentage is then unavailable rather than wrong.
 *
 * **What the session actually used outranks the table.** If a conversation was
 * observed occupying more than the listed window, the listing is wrong — a
 * model id was added to a tier by hand, or the vendor changed one — so the
 * window is raised to the smallest listed tier that still contains the reading.
 * That keeps the gauge from sitting pinned at 100% while the session goes on
 * growing, and it stays `inferred`, because it still is.
 */

import { normalizeModelId } from "@workspace/domain";

/** The windows any model here has, smallest first. Used to escalate a wrong guess. */
const TIERS = [200_000, 258_400, 1_000_000] as const;

/**
 * Context window by exact model id.
 *
 * Anthropic's own pricing page is the source for the Claude half: Claude 4.6
 * and later carry the full 1M window at standard rates, and everything before
 * it is 200k. The Codex ids are here only for a rollout old enough to predate
 * the `model_context_window` field; a current one never reaches this lookup.
 */
const WINDOWS: Readonly<Record<string, number>> = {
  "claude-fable-5": 1_000_000,
  "claude-haiku-3-5": 200_000,
  "claude-haiku-4-5": 200_000,
  "claude-mythos-5": 1_000_000,
  "claude-opus-4": 200_000,
  "claude-opus-4-1": 200_000,
  "claude-opus-4-5": 200_000,
  "claude-opus-4-6": 1_000_000,
  "claude-opus-4-7": 1_000_000,
  "claude-opus-4-8": 1_000_000,
  "claude-opus-5": 1_000_000,
  "claude-sonnet-4": 200_000,
  "claude-sonnet-4-5": 200_000,
  "claude-sonnet-4-6": 1_000_000,
  "claude-sonnet-5": 1_000_000,
  "gpt-5": 258_400,
  "gpt-5-1": 258_400,
  "gpt-5-2": 258_400,
  "gpt-5-3-codex": 258_400,
  "gpt-5-4": 258_400,
  "gpt-5-5": 258_400,
  "gpt-5-6-luna": 258_400,
  "gpt-5-6-sol": 258_400,
  "gpt-5-6-terra": 258_400,
};

/** The listed window for a model id, or null when the id is not listed. */
export const windowOfModel = (model: string | null) =>
  model === null ? null : (WINDOWS[normalizeModelId(model)] ?? null);

/** The smallest listed tier that contains a reading, or null when none does. */
const tierAbove = (tokens: number) =>
  TIERS.find((tier) => tier >= tokens) ?? null;

/** A denominator and whether it can be trusted as the provider's own. */
export interface ContextWindow {
  readonly source: "inferred" | "reported";
  readonly tokens: number;
}

/** What the summary knows about a session's window before it resolves one. */
export interface WindowInput {
  /** Every model the session used. The largest window among them wins — see below. */
  readonly models: readonly string[];
  /** The largest context any request in the session occupied. */
  readonly peakContextTokens: number;
  /** The provider's own figure, where it wrote one down. */
  readonly reported: number | null;
}

/**
 * The window a percentage is measured against, or null when nothing can say.
 *
 * A session that switched model takes the largest window of the models it used,
 * because the readings on the curve were taken under several and the smallest
 * one would put earlier requests over 100% of a window they never ran against.
 */
export const resolveContextWindow = (
  input: WindowInput
): ContextWindow | null => {
  if (input.reported !== null && input.reported > 0) {
    return { source: "reported", tokens: input.reported };
  }
  const listed = input.models
    .map(windowOfModel)
    .filter((window): window is number => window !== null);
  const largest = listed.length === 0 ? null : Math.max(...listed);
  if (largest === null) {
    return null;
  }
  if (input.peakContextTokens <= largest) {
    return { source: "inferred", tokens: largest };
  }
  const escalated = tierAbove(input.peakContextTokens);
  return escalated === null ? null : { source: "inferred", tokens: escalated };
};
