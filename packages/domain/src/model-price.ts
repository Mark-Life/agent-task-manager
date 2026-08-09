/**
 * What a model costs, as one dated table, and the only place a dollar figure in
 * this system is worked out.
 *
 * Neither provider writes money into its transcript. Claude records tokens and
 * Codex records tokens and its context window; the price is ours to apply. That
 * makes every cost here derived, and derived numbers rot — a table copied into
 * three files is three tables, two of which are wrong by the time anyone
 * notices. So there is one, it carries the day its figures were read, and the
 * version travels with every figure it produces so a stored cost says which
 * table produced it.
 *
 * **A model that is not in the table has no price.** {@link priceOf} answers
 * null rather than guessing from a family name, and a summary built on it
 * reports how many requests it could not price. A confident wrong dollar figure
 * is worse than an absent one: nobody audits a number that looks right.
 *
 * **Rates are per million tokens, and the four kinds are priced apart** because
 * they differ by two orders of magnitude — a cache read is a tenth of fresh
 * input and a one-hour cache write is twice it, so a session that is 90% cache
 * reads costs a fraction of what a flat input rate would claim.
 *
 * What is deliberately not modelled, and would make a figure too low: the 1.1x
 * data-residency multiplier on `inference_geo: "us"`, server-tool charges such
 * as web search at $10 per 1,000 searches, and the Batch API discount, which no
 * interactive session takes. Subscription runs are not billed per token at all —
 * these figures are what the same work would have cost on the API, which is the
 * only comparable number a board can put on a task.
 */

import { Schema } from "effect";
import { CostUsd } from "./primitives";

/**
 * Bumped whenever a rate below changes. Stored beside every cost, so a figure
 * from an older table is recognisable as one rather than silently compared with
 * a newer one.
 */
export const PRICE_TABLE_VERSION = 1;

/** The day these figures were read off the vendors' own pricing pages. */
export const PRICE_TABLE_EFFECTIVE = "2026-08-08";

/** Where they were read from, so the next person updating them starts there. */
export const PRICE_TABLE_SOURCES = [
  "https://platform.claude.com/docs/en/about-claude/pricing",
  "https://developers.openai.com/api/docs/pricing",
] as const;

/** Rates are quoted per million tokens; charges are worked out per token. */
const PER_MILLION = 1_000_000;

/**
 * Decimals kept on a derived cost. Six is finer than any per-request charge a
 * session produces and stays inside the pattern {@link CostUsd} checks.
 */
const COST_DECIMALS = 6;

/**
 * One model's rates, in dollars per million tokens.
 *
 * The two cache-write rates are separate because Claude bills a five-minute
 * cache at 1.25x input and a one-hour cache at 2x, and Claude Code writes
 * one-hour caches — pricing both at the cheaper rate would understate a long
 * session by most of its cache cost. A provider that has no such rate carries
 * null, and tokens charged against a null rate are reported as unpriced rather
 * than as free.
 */
export interface ModelPrice {
  /** A cache hit, which every provider discounts steeply. */
  readonly cacheRead: number;
  /** Writing a one-hour cache entry. Null where the provider has no such thing. */
  readonly cacheWrite1h: number | null;
  /** Writing a five-minute cache entry. Null where the provider has no such thing. */
  readonly cacheWrite5m: number | null;
  /** Fresh, uncached prompt tokens. */
  readonly input: number;
  readonly output: number;
}

/** Claude's cache rates are fixed multiples of its input rate, so they are derived, not retyped. */
const claudePrice = (input: number, output: number): ModelPrice => ({
  cacheRead: input * 0.1,
  cacheWrite1h: input * 2,
  cacheWrite5m: input * 1.25,
  input,
  output,
});

/** A model priced only on input and output, which is every OpenAI model here. */
const flatPrice = (
  input: number,
  cacheRead: number,
  output: number
): ModelPrice => ({
  cacheRead,
  cacheWrite1h: null,
  cacheWrite5m: null,
  input,
  output,
});

/**
 * Every model this board can dispatch, plus the ones a resumed session may
 * still carry, keyed by the id the provider writes into its own transcript.
 *
 * Claude Code writes `claude-opus-5`; the API's dated ids
 * (`claude-opus-4-5-20250929`) reach here with the date stripped, which is the
 * only normalization applied — a family-name substring match is how
 * `claude-opus-4-1` at $15 would quietly be priced as `claude-opus-4-5` at $5.
 *
 * Sonnet 5 is at its introductory rate, which expires on 31 August 2026 and
 * becomes $3/$15. That is a table edit on the day, not a branch here: a price
 * that changes itself by reading the clock is a price nobody can reproduce.
 */
const PRICES: Readonly<Record<string, ModelPrice>> = {
  // Anthropic, standard speed.
  "claude-fable-5": claudePrice(10, 50),
  "claude-haiku-3-5": claudePrice(0.8, 4),
  "claude-haiku-4-5": claudePrice(1, 5),
  "claude-mythos-5": claudePrice(10, 50),
  "claude-opus-4": claudePrice(15, 75),
  "claude-opus-4-1": claudePrice(15, 75),
  "claude-opus-4-5": claudePrice(5, 25),
  "claude-opus-4-6": claudePrice(5, 25),
  "claude-opus-4-7": claudePrice(5, 25),
  "claude-opus-4-8": claudePrice(5, 25),
  "claude-opus-5": claudePrice(5, 25),
  "claude-sonnet-4": claudePrice(3, 15),
  "claude-sonnet-4-5": claudePrice(3, 15),
  "claude-sonnet-4-6": claudePrice(3, 15),
  "claude-sonnet-5": claudePrice(2, 10),

  // OpenAI. The three this board dispatches are the 5.6 family; the rest are
  // here for a session that ran before a model change.
  "gpt-5": flatPrice(1.25, 0.125, 10),
  "gpt-5-1": flatPrice(1.25, 0.125, 10),
  "gpt-5-2": flatPrice(1.75, 0.175, 14),
  "gpt-5-3-codex": flatPrice(1.75, 0.175, 14),
  "gpt-5-4": flatPrice(2.5, 0.25, 15),
  "gpt-5-4-mini": flatPrice(0.75, 0.075, 4.5),
  "gpt-5-4-nano": flatPrice(0.2, 0.02, 1.25),
  "gpt-5-5": flatPrice(5, 0.5, 30),
  "gpt-5-6-luna": flatPrice(0.2, 0.02, 1.2),
  "gpt-5-6-sol": flatPrice(5, 0.5, 30),
  "gpt-5-6-terra": flatPrice(2, 0.2, 12),
  "gpt-5-mini": flatPrice(0.25, 0.025, 2),
  "gpt-5-nano": flatPrice(0.05, 0.005, 0.4),
};

/**
 * Fast mode, which is a different price for the same model id and is reported
 * as `speed` on the usage block rather than in the id. Priced across the whole
 * window, and prompt-cache multipliers still apply on top.
 */
const FAST_PRICES: Readonly<Record<string, ModelPrice>> = {
  "claude-opus-4-8": claudePrice(10, 50),
  "claude-opus-5": claudePrice(10, 50),
};

/** How a provider names the speed tier a request ran at, where it names one. */
export const MODEL_SPEEDS = ["fast", "standard"] as const;

export const ModelSpeed = Schema.Literals(MODEL_SPEEDS);
export type ModelSpeed = typeof ModelSpeed.Type;

/** A trailing release date on an API model id: `claude-opus-4-5-20250929`. */
const DATED_SUFFIX = /-\d{8}$/;

/**
 * The id a price is looked up under: the vendor's own, lowercased, with a
 * release date stripped and dots folded to hyphens so `gpt-5.6-sol` and
 * `gpt-5-6-sol` are the one model they are.
 */
export const normalizeModelId = (model: string) =>
  model.toLowerCase().replace(DATED_SUFFIX, "").replaceAll(".", "-");

/**
 * What one model costs, or null when the table has never heard of it. Null is
 * the answer that keeps a wrong figure out of the UI, and callers report the
 * requests they could not price rather than dropping them.
 */
export const priceOf = (
  model: string | null,
  speed: ModelSpeed | null = null
): ModelPrice | null => {
  if (model === null) {
    return null;
  }
  const id = normalizeModelId(model);
  const fast = speed === "fast" ? FAST_PRICES[id] : undefined;
  return fast ?? PRICES[id] ?? null;
};

/** What one request consumed, split by the four rates that price it apart. */
export interface TokenCharge {
  readonly cacheReadTokens: number;
  /** Claude's one-hour cache writes, which cost twice fresh input. */
  readonly cacheWrite1hTokens: number;
  /** Claude's five-minute cache writes, at 1.25x fresh input. */
  readonly cacheWrite5mTokens: number;
  /** Fresh prompt tokens: what neither cache covered. */
  readonly inputTokens: number;
  readonly outputTokens: number;
}

/** A charge that has counted nothing yet, and the value a fold starts from. */
export const EMPTY_TOKEN_CHARGE: TokenCharge = {
  cacheReadTokens: 0,
  cacheWrite1hTokens: 0,
  cacheWrite5mTokens: 0,
  inputTokens: 0,
  outputTokens: 0,
};

/** Adds two charges, so a session's total is one fold over its requests. */
export const addCharge = (
  left: TokenCharge,
  right: TokenCharge
): TokenCharge => ({
  cacheReadTokens: left.cacheReadTokens + right.cacheReadTokens,
  cacheWrite1hTokens: left.cacheWrite1hTokens + right.cacheWrite1hTokens,
  cacheWrite5mTokens: left.cacheWrite5mTokens + right.cacheWrite5mTokens,
  inputTokens: left.inputTokens + right.inputTokens,
  outputTokens: left.outputTokens + right.outputTokens,
});

/**
 * What a charge would have cost on the API at this model's rates, in dollars,
 * as a float — summed by the caller and turned into a {@link CostUsd} once, at
 * the end, because money that has been through repeated float addition no
 * longer adds up.
 *
 * Cache-write tokens charged against a provider with no cache-write rate fall
 * back to the input rate rather than to zero: they were real prompt tokens, and
 * the alternative is a cost that is quietly too low.
 */
export const chargeUsd = (price: ModelPrice, charge: TokenCharge) =>
  (charge.inputTokens * price.input +
    charge.cacheReadTokens * price.cacheRead +
    charge.cacheWrite5mTokens * (price.cacheWrite5m ?? price.input) +
    charge.cacheWrite1hTokens * (price.cacheWrite1h ?? price.input) +
    charge.outputTokens * price.output) /
  PER_MILLION;

/** A float total, as the exact decimal a cost is carried and stored as. */
export const toCostUsd = (total: number) =>
  CostUsd.make(total.toFixed(COST_DECIMALS));
