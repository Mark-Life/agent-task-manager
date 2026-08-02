/**
 * The stuck rule, given sequences of events.
 *
 * Every case is the same run with one thing changed, because the value of the
 * rule is in what it refuses to call stuck: a busy run, a young run, a quiet
 * one. A heuristic that cries wolf is worse than none, so the misses are tested
 * as carefully as the hit.
 */

import { describe, expect, test } from "bun:test";
import { DateTime } from "effect";
import type { RunEventSample, StuckThresholds } from "./rule";
import { stuckVerdict, toolSignature } from "./rule";

const NOW = DateTime.makeUnsafe("2026-08-02T12:00:00.000Z");

const MS_PER_MINUTE = 60_000;

const THRESHOLDS: StuckThresholds = {
  distinctSignatures: 2,
  minToolCalls: 6,
  windowMinutes: 10,
};

/** A run old enough to be judged: started well before the window opened. */
const STARTED_AT = DateTime.makeUnsafe("2026-08-02T11:00:00.000Z");

/** One `tool_call` event, `minutesAgo` before {@link NOW}. */
const toolCall = (options: {
  readonly minutesAgo: number;
  readonly summary: string;
  readonly toolName: string;
}): RunEventSample => ({
  occurredAt: DateTime.makeUnsafe(
    DateTime.toEpochMillis(NOW) - options.minutesAgo * MS_PER_MINUTE
  ),
  payload: {
    callId: `call-${options.minutesAgo}`,
    inputChars: 32,
    kind: "tool_call",
    summary: options.summary,
    toolName: options.toolName,
  },
});

/** Nine repeats of the same two reads, spread across the last nine minutes. */
const spinning = (): readonly RunEventSample[] =>
  Array.from({ length: 9 }, (_, index) =>
    toolCall({
      minutesAgo: index + 1,
      summary: index % 2 === 0 ? "packages/db" : "run.ts",
      toolName: index % 2 === 0 ? "Glob" : "Read",
    })
  );

const verdictOf = (
  events: readonly RunEventSample[],
  thresholds: StuckThresholds = THRESHOLDS
) => stuckVerdict({ events, now: NOW, startedAt: STARTED_AT, thresholds });

describe("stuckVerdict", () => {
  test("calls a run stuck when it repeats two reads and edits nothing", () => {
    const verdict = verdictOf(spinning());
    expect(verdict.kind).toBe("stuck");
    if (verdict.kind !== "stuck") {
      return;
    }
    expect(verdict.toolCalls).toBe(9);
    expect(verdict.signatures).toEqual(["Glob packages/db", "Read run.ts"]);
    // No edit anywhere in the run, so the clock runs from its start.
    expect(verdict.stuckForMs).toBe(60 * MS_PER_MINUTE);
  });

  test("a single file edit in the window clears it", () => {
    const verdict = verdictOf([
      ...spinning(),
      toolCall({ minutesAgo: 4, summary: "run.ts", toolName: "Edit" }),
    ]);
    expect(verdict).toEqual({ kind: "working", reason: "edited_files" });
  });

  test("an edit before the window still dates how long it has looked stuck", () => {
    const verdict = verdictOf([
      toolCall({ minutesAgo: 15, summary: "run.ts", toolName: "Write" }),
      ...spinning(),
    ]);
    expect(verdict.kind).toBe("stuck");
    if (verdict.kind === "stuck") {
      expect(verdict.stuckForMs).toBe(15 * MS_PER_MINUTE);
    }
  });

  test("varied work is not stuck, however much of it there is", () => {
    const verdict = verdictOf(
      Array.from({ length: 12 }, (_, index) =>
        toolCall({
          minutesAgo: index % 9,
          summary: `file-${index}.ts`,
          toolName: "Read",
        })
      )
    );
    expect(verdict).toEqual({ kind: "working", reason: "varied_signatures" });
  });

  test("a thinking run with few calls is left alone", () => {
    const verdict = verdictOf(spinning().slice(0, 3));
    expect(verdict).toEqual({
      kind: "working",
      reason: "too_few_tool_calls",
    });
  });

  test("calls older than the window do not count toward the minimum", () => {
    const verdict = verdictOf(
      Array.from({ length: 9 }, (_, index) =>
        toolCall({
          minutesAgo: 11 + index,
          summary: "packages/db",
          toolName: "Glob",
        })
      )
    );
    expect(verdict).toEqual({
      kind: "working",
      reason: "too_few_tool_calls",
    });
  });

  test("a run younger than the window is never stuck", () => {
    const verdict = stuckVerdict({
      events: spinning(),
      now: NOW,
      startedAt: DateTime.makeUnsafe(
        DateTime.toEpochMillis(NOW) - 5 * MS_PER_MINUTE
      ),
      thresholds: THRESHOLDS,
    });
    expect(verdict).toEqual({ kind: "working", reason: "too_young" });
  });

  test("a run that never started has nothing to judge", () => {
    const verdict = stuckVerdict({
      events: spinning(),
      now: NOW,
      startedAt: null,
      thresholds: THRESHOLDS,
    });
    expect(verdict).toEqual({ kind: "working", reason: "not_started" });
  });

  test("non-tool events are ignored", () => {
    const verdict = verdictOf([
      ...spinning(),
      {
        occurredAt: NOW,
        payload: { chars: 400, kind: "reasoning" },
      },
    ]);
    expect(verdict.kind).toBe("stuck");
  });

  test("the thresholds are the rule: a tighter one refuses the same run", () => {
    const verdict = verdictOf(spinning(), {
      distinctSignatures: 1,
      minToolCalls: 6,
      windowMinutes: 10,
    });
    expect(verdict).toEqual({ kind: "working", reason: "varied_signatures" });
  });
});

describe("toolSignature", () => {
  test("joins the tool to its summary, so the same call twice is one value", () => {
    expect(toolSignature({ summary: "packages/db", toolName: "Glob" })).toBe(
      "Glob packages/db"
    );
  });
});
