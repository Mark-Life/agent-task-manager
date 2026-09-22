import { describe, expect, test } from "bun:test";
import { resolveContextWindow, windowOfModel } from "./model-window";

describe("the window a model id carries", () => {
  test("lists the 1M models and the 200k ones apart", () => {
    expect(windowOfModel("claude-opus-5")).toBe(1_000_000);
    expect(windowOfModel("claude-opus-4-5")).toBe(200_000);
    expect(windowOfModel("claude-haiku-4-5")).toBe(200_000);
  });

  test("windows the models this bump added, all three at 1M", () => {
    expect(windowOfModel("claude-opus-5-5")).toBe(1_000_000);
    expect(windowOfModel("claude-fable-5-1")).toBe(1_000_000);
    expect(windowOfModel("claude-mythos-5-1")).toBe(1_000_000);
  });

  test("normalizes the id the way the price table does", () => {
    expect(windowOfModel("claude-opus-5-5-20260922")).toBe(1_000_000);
    expect(windowOfModel("gpt-5.6-sol")).toBe(258_400);
  });

  test("answers nothing for an id nobody listed", () => {
    // Absent rather than guessed: a family substring match is how a 200k model
    // gets a 1M denominator and a full session reads as comfortable.
    expect(windowOfModel("claude-opus-9")).toBeNull();
    expect(windowOfModel(null)).toBeNull();
  });
});

describe("resolving the window a percentage is measured against", () => {
  test("prefers the provider's own figure over the table", () => {
    expect(
      resolveContextWindow({
        models: ["claude-opus-5-5"],
        peakContextTokens: 1000,
        reported: 258_400,
      })
    ).toEqual({ source: "reported", tokens: 258_400 });
  });

  test("infers from the model, and says so", () => {
    expect(
      resolveContextWindow({
        models: ["claude-opus-5-5"],
        peakContextTokens: 400_000,
        reported: null,
      })
    ).toEqual({ source: "inferred", tokens: 1_000_000 });
  });

  test("has nothing to measure against for an unlisted model", () => {
    expect(
      resolveContextWindow({
        models: ["claude-opus-9"],
        peakContextTokens: 1000,
        reported: null,
      })
    ).toBeNull();
  });
});
