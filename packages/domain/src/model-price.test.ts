import { describe, expect, test } from "bun:test";
import {
  chargeUsd,
  EMPTY_TOKEN_CHARGE,
  normalizeModelId,
  PRICE_TABLE_EFFECTIVE,
  PRICE_TABLE_VERSION,
  priceOf,
  toCostUsd,
} from "./model-price";

describe("looking a model up", () => {
  test("strips a release date and folds the dots a provider writes", () => {
    expect(normalizeModelId("claude-opus-4-5-20250929")).toBe(
      "claude-opus-4-5"
    );
    expect(normalizeModelId("gpt-5.6-sol")).toBe("gpt-5-6-sol");
  });

  test("answers nothing for a model it has never heard of", () => {
    // The whole reason there is no family-substring fallback: `claude-opus-4-1`
    // costs three times what `claude-opus-4-5` does, and a fuzzy match is how
    // one gets priced as the other without anybody noticing.
    expect(priceOf("claude-opus-9")).toBeNull();
    expect(priceOf("gpt-6")).toBeNull();
    expect(priceOf(null)).toBeNull();
  });

  test("prices fast mode apart, and only where fast mode exists", () => {
    expect(priceOf("claude-opus-5", "fast")?.input).toBe(10);
    expect(priceOf("claude-opus-5", "standard")?.input).toBe(5);
    // Sonnet has no fast tier, so asking for one gets the standard rates rather
    // than nothing at all.
    expect(priceOf("claude-sonnet-5", "fast")?.input).toBe(2);
  });

  test("derives Claude's cache rates from its input rate", () => {
    const price = priceOf("claude-opus-5");
    expect(price?.cacheRead).toBeCloseTo(0.5, 6);
    expect(price?.cacheWrite5m).toBeCloseTo(6.25, 6);
    expect(price?.cacheWrite1h).toBeCloseTo(10, 6);
  });
});

describe("charging a model", () => {
  test("bills each kind at its own rate", () => {
    const price = priceOf("claude-opus-5");
    if (price === null) {
      throw new Error("claude-opus-5 must be priced");
    }
    const usd = chargeUsd(price, {
      ...EMPTY_TOKEN_CHARGE,
      cacheReadTokens: 1_000_000,
      cacheWrite1hTokens: 1_000_000,
      inputTokens: 1_000_000,
      outputTokens: 1_000_000,
    });
    expect(usd).toBeCloseTo(5 + 0.5 + 10 + 25, 6);
  });

  test("charges cache writes at the input rate where a provider has no cache rate", () => {
    const price = priceOf("gpt-5-6-sol");
    if (price === null) {
      throw new Error("gpt-5-6-sol must be priced");
    }
    // Zero would be a discount nobody offered; these were real prompt tokens.
    expect(
      chargeUsd(price, {
        ...EMPTY_TOKEN_CHARGE,
        cacheWrite5mTokens: 1_000_000,
      })
    ).toBeCloseTo(price.input, 6);
  });

  test("carries money as an exact decimal, never a float", () => {
    expect(String(toCostUsd(0.1 + 0.2))).toBe("0.300000");
  });
});

/** An ISO date, which is what a dated table has to carry. */
const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

test("the table says how old it is", () => {
  expect(PRICE_TABLE_VERSION).toBeGreaterThan(0);
  expect(PRICE_TABLE_EFFECTIVE).toMatch(ISO_DATE);
});
