import { describe, expect, test } from "bun:test";
import {
  detectRateLimitStatus,
  detectUsageLimitText,
  looksRateLimitShaped,
} from "./detect";

describe("detectUsageLimitText", () => {
  test("matches the phrasings a drained run actually produces", () => {
    for (const message of [
      "You've hit your usage limit. Try again later.",
      "Error: rate limit exceeded",
      "stream error: 429 Too Many Requests",
      "rate_limit_exceeded",
      "Your weekly quota has been used up",
      "TOO MANY REQUESTS",
    ]) {
      expect(detectUsageLimitText(message)).toBe(true);
    }
  });

  test("stays quiet on failures that have nothing to do with allowance", () => {
    for (const message of [
      "",
      "ENOENT: no such file or directory",
      "TypeError: undefined is not a function",
      "git push rejected: non-fast-forward",
      "the agent exited with code 1",
    ]) {
      expect(detectUsageLimitText(message)).toBe(false);
    }
  });

  test("a guard vetoes a match, so a prompt-size error never pauses a provider", () => {
    for (const message of [
      "context length limit exceeded for this model",
      "prompt exceeds the maximum context window",
      "token limit reached for the request",
      "tool call limit hit",
      "blocked by content policy",
    ]) {
      expect(detectUsageLimitText(message)).toBe(false);
    }
  });
});

describe("looksRateLimitShaped", () => {
  test("fires on the ambiguous middle, which is where the wording drifts", () => {
    expect(looksRateLimitShaped("context length limit exceeded")).toBe(true);
    expect(looksRateLimitShaped("requests are being throttled upstream")).toBe(
      true
    );
    expect(looksRateLimitShaped("resource exhausted, retry")).toBe(true);
  });

  test("stays quiet on a confident match and on an unrelated failure", () => {
    expect(looksRateLimitShaped("usage limit reached")).toBe(false);
    expect(looksRateLimitShaped("ENOENT no such file")).toBe(false);
    expect(looksRateLimitShaped("")).toBe(false);
  });
});

describe("detectRateLimitStatus", () => {
  test("only a refusal is a drain — a warning arrives while allowance is left", () => {
    expect(detectRateLimitStatus("rejected")).toBe(true);
    expect(detectRateLimitStatus("allowed_warning")).toBe(false);
    expect(detectRateLimitStatus("allowed")).toBe(false);
    expect(detectRateLimitStatus(null)).toBe(false);
  });
});
