/**
 * The resume gate, which is pure and therefore testable without a container, a
 * provider or a database. Every case below is a shape the loop has actually
 * produced or could produce on the next timeout.
 */

import { describe, expect, test } from "bun:test";
import { isResumable, RESUMABLE_OUTCOMES } from "./agent-session";
import type { RunOutcome, SessionStatus } from "./enums";
import { RUN_OUTCOMES, SESSION_STATUSES } from "./enums";

/** A candidate, spelled at the call site as the two things the gate reads. */
const candidate = (status: SessionStatus, ...outcomes: RunOutcome[]) => ({
  outcomes,
  session: { status },
});

describe("RESUMABLE_OUTCOMES", () => {
  test("names no outcome outside the union", () => {
    const known = new Set<string>(RUN_OUTCOMES);
    for (const outcome of RESUMABLE_OUTCOMES) {
      expect(known.has(outcome)).toBe(true);
    }
  });

  test("leaves out every ending that is neither clean nor the wall clock", () => {
    const listed = new Set<string>(RESUMABLE_OUTCOMES);
    const rest = RUN_OUTCOMES.filter((outcome) => !listed.has(outcome));
    expect(rest).toEqual(["errored", "interrupted", "stopped", "lost"]);
  });
});

describe("isResumable", () => {
  test("a session that has not failed is resumable whatever its runs did", () => {
    for (const status of SESSION_STATUSES.filter((s) => s !== "failed")) {
      for (const outcome of RUN_OUTCOMES) {
        expect(isResumable(candidate(status, outcome))).toBe(true);
      }
      expect(isResumable(candidate(status))).toBe(true);
    }
  });

  test("a failed session whose last run hit the wall clock is resumable", () => {
    expect(isResumable(candidate("failed", "timeout"))).toBe(true);
  });

  test("a failed session that crashed, went quiet or was interrupted is not", () => {
    expect(isResumable(candidate("failed", "errored"))).toBe(false);
    expect(isResumable(candidate("failed", "lost"))).toBe(false);
    expect(isResumable(candidate("failed", "interrupted"))).toBe(false);
  });

  test("a failed session somebody stopped is not — the stop is the answer", () => {
    expect(isResumable(candidate("failed", "stopped"))).toBe(false);
  });

  test("only the newest run decides; older ones are history", () => {
    expect(isResumable(candidate("failed", "timeout", "errored"))).toBe(true);
    expect(isResumable(candidate("failed", "errored", "timeout"))).toBe(false);
  });

  test("a wall the session has already been resumed into is not walked twice", () => {
    expect(isResumable(candidate("failed", "timeout", "timeout"))).toBe(false);
    expect(
      isResumable(candidate("failed", "timeout", "errored", "timeout"))
    ).toBe(false);
  });

  test("a failed session with no finished run has nothing to resume into", () => {
    expect(isResumable(candidate("failed"))).toBe(false);
  });
});
