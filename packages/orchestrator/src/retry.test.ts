import { describe, expect, test } from "bun:test";
import { DateTime } from "effect";
import { decideRetry, isParked, parkRemainingMs } from "./retry";

const policy = {
  maxAttempts: 5,
  parkMs: 86_400_000,
  retryBaseMs: 60_000,
  retryMaxMs: 1_800_000,
};

const NOW = 1_700_000_000_000;

describe("decideRetry", () => {
  test("walks the ladder while attempts remain", () => {
    const first = decideRetry({ attempt: 1, nowMs: NOW, policy });
    expect(first.kind).toBe("retry");
    expect(first.delayMs).toBe(60_000);
    expect(first.resumesAtMs).toBe(NOW + 60_000);

    const third = decideRetry({ attempt: 3, nowMs: NOW, policy });
    expect(third.delayMs).toBe(240_000);
  });

  test("counts the next attempt so the run row carries it", () => {
    const decision = decideRetry({ attempt: 2, nowMs: NOW, policy });
    expect(decision.kind === "retry" && decision.nextAttempt).toBe(3);
  });

  test("parks once the last attempt has failed, for a day rather than a backoff", () => {
    const decision = decideRetry({ attempt: 5, nowMs: NOW, policy });
    expect(decision.kind).toBe("park");
    expect(decision.delayMs).toBe(policy.parkMs);
    expect(decision.resumesAtMs).toBe(NOW + policy.parkMs);
  });

  test("stays parked past the last attempt rather than resuming the ladder", () => {
    expect(decideRetry({ attempt: 9, nowMs: NOW, policy }).kind).toBe("park");
  });

  test("a park is always the longer wait, so it cannot read as a fast retry", () => {
    const lastRetry = decideRetry({ attempt: 4, nowMs: NOW, policy });
    const parked = decideRetry({ attempt: 5, nowMs: NOW, policy });
    expect(parked.delayMs).toBeGreaterThan(lastRetry.delayMs);
  });
});

describe("isParked", () => {
  test("an unstamped task is never skipped", () => {
    expect(isParked({ nowMs: NOW, parkedUntil: null })).toBe(false);
  });

  test("a stamp in the future skips, one in the past does not", () => {
    const future = DateTime.makeUnsafe(NOW + 1000);
    const past = DateTime.makeUnsafe(NOW - 1000);
    expect(isParked({ nowMs: NOW, parkedUntil: future })).toBe(true);
    expect(isParked({ nowMs: NOW, parkedUntil: past })).toBe(false);
  });

  test("the instant the wait ends the task dispatches, rather than a tick later", () => {
    const exactly = DateTime.makeUnsafe(NOW);
    expect(isParked({ nowMs: NOW, parkedUntil: exactly })).toBe(false);
  });
});

describe("parkRemainingMs", () => {
  test("reports what is left, and never a negative wait", () => {
    expect(
      parkRemainingMs({
        nowMs: NOW,
        parkedUntil: DateTime.makeUnsafe(NOW + 5000),
      })
    ).toBe(5000);
    expect(
      parkRemainingMs({
        nowMs: NOW,
        parkedUntil: DateTime.makeUnsafe(NOW - 5000),
      })
    ).toBe(0);
    expect(parkRemainingMs({ nowMs: NOW, parkedUntil: null })).toBe(0);
  });
});
