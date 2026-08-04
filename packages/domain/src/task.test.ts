import { describe, expect, test } from "bun:test";
import { DateTime, Schema } from "effect";
import { newAgentSessionId, newTaskId } from "./ids";
import {
  DEFAULT_NEXT_SESSION,
  NextSession,
  nextSessionColumns,
  nextSessionOf,
  RANK_STEP,
  rankBetween,
  Task,
} from "./task";

const now = new Date("2026-08-01T09:00:00.000Z");

const row: typeof Task.Encoded = {
  acceptance: null,
  brief: "Read the article and file what is worth doing.",
  createdAt: now,
  dispatchTraceparent: null,
  id: newTaskId(),
  metadata: { articleUrl: "https://example.com/a", readingMinutes: 12 },
  nextSessionId: null,
  nextSessionNew: false,
  parentTaskId: null,
  parkedUntil: null,
  projectId: null,
  prUrl: null,
  rank: 0,
  repoUrl: null,
  sandboxImage: null,
  status: "backlog",
  statusChangedAt: now,
  title: "Triage the article",
  updatedAt: now,
  workspaceId: "8f6ba3cc0d2a4a0f9b1f7e2c5d3a6b41",
};

describe("Task", () => {
  test("round-trips a row without losing or inventing a field", () => {
    const decoded = Schema.decodeUnknownSync(Task)(row);
    expect(Schema.encodeSync(Task)(decoded)).toEqual(row);
  });

  test("decodes timestamps into zone-aware values, not strings", () => {
    const decoded = Schema.decodeUnknownSync(Task)(row);
    expect(DateTime.toEpochMillis(decoded.statusChangedAt)).toBe(now.getTime());
  });

  test("rejects a status outside the union", () => {
    expect(() =>
      Schema.decodeUnknownSync(Task)({ ...row, status: "archived" })
    ).toThrow();
  });

  test("rejects an empty title", () => {
    expect(() =>
      Schema.decodeUnknownSync(Task)({ ...row, title: "" })
    ).toThrow();
  });
});

describe("nextSessionOf", () => {
  test("reads the default selection off the columns", () => {
    expect(nextSessionOf(DEFAULT_NEXT_SESSION)).toEqual(
      NextSession.cases.latest.make({})
    );
  });

  test("asks for a fresh session, which an id alone cannot say", () => {
    expect(
      nextSessionOf({ nextSessionId: null, nextSessionNew: true })
    ).toEqual(NextSession.cases.new.make({}));
  });

  test("falls back to the default when a pinned session has gone", () => {
    expect(
      nextSessionOf({ nextSessionId: null, nextSessionNew: false })
    ).toEqual(NextSession.cases.latest.make({}));
  });

  test("is the inverse of nextSessionColumns", () => {
    const sessionId = newAgentSessionId();
    const selections = [
      NextSession.cases.latest.make({}),
      NextSession.cases.new.make({}),
      NextSession.cases.specific.make({ sessionId }),
    ];
    for (const selection of selections) {
      expect(nextSessionOf(nextSessionColumns(selection))).toEqual(selection);
    }
  });
});

describe("rankBetween", () => {
  test("lands strictly between two neighbours", () => {
    expect(rankBetween(0, 1024)).toBe(512);
    expect(rankBetween(512, 1024)).toBe(768);
  });

  test("appends below the last card and above the first", () => {
    expect(rankBetween(1024, null)).toBe(1024 + RANK_STEP);
    expect(rankBetween(null, 0)).toBe(-RANK_STEP);
  });

  test("starts an empty column at zero", () => {
    expect(rankBetween(null, null)).toBe(0);
  });

  test("keeps the column ordered after repeated drops into the same gap", () => {
    let above = 0;
    const below = 1024;
    for (const _drop of Array.from({ length: 20 })) {
      const placed = rankBetween(above, below);
      expect(placed).toBeGreaterThan(above);
      expect(placed).toBeLessThan(below);
      above = placed;
    }
  });
});
