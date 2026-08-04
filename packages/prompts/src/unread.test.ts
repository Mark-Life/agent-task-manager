/**
 * The watermark is a tuple, and every test here is about why.
 *
 * Two rows can share a millisecond — the column keeps microseconds and the
 * domain's `Timestamp` keeps milliseconds — so a comparison on the timestamp
 * alone either re-reads the row the watermark names or skips its twin forever.
 * Both failures are silent and both are permanent, which is why they are
 * pinned here rather than left to the database's ordering.
 */

import { describe, expect, test } from "bun:test";
import { type CommentId, newCommentId } from "@workspace/domain";
import { DateTime } from "effect";
import { isAfterWatermark, nextWatermarkOf, unreadOf } from "./unread";

const at = DateTime.makeUnsafe("2026-08-02T10:00:00.000Z");
const later = DateTime.makeUnsafe("2026-08-02T11:00:00.000Z");

/** Any append-only row: the two fields the algebra reads, and nothing else. */
interface Row {
  readonly body: string;
  readonly createdAt: DateTime.Utc;
  readonly id: CommentId;
}

const row = (body: string, createdAt = at): Row => ({
  body,
  createdAt,
  id: newCommentId(),
});

const first = row("one");
const second = row("two");
const third = row("three", later);

describe("what a session has genuinely not read", () => {
  test("drops the row the watermark itself names", () => {
    expect(
      unreadOf({
        rows: [second, third],
        watermark: { createdAt: second.createdAt, id: second.id },
      })
    ).toEqual([third]);
  });

  test("keeps a same-millisecond sibling the watermark does not cover", () => {
    expect(first.createdAt).toEqual(second.createdAt);
    expect(
      unreadOf({
        rows: [first, second],
        watermark: { createdAt: first.createdAt, id: first.id },
      })
    ).toEqual([second]);
  });

  test("a null watermark has seen nothing, which is how a fresh session reads", () => {
    expect(unreadOf({ rows: [first, second, third], watermark: null })).toEqual(
      [first, second, third]
    );
  });

  test("compares the id only when the millisecond ties", () => {
    expect(isAfterWatermark(third, second)).toBe(true);
    expect(isAfterWatermark(second, third)).toBe(false);
    expect(isAfterWatermark(first, { createdAt: at, id: "" })).toBe(true);
  });
});

describe("where the watermark lands after a read", () => {
  test("advances to the last row rendered, not the newest timestamp", () => {
    expect(nextWatermarkOf([third, first])).toEqual({
      createdAt: first.createdAt,
      id: first.id,
    });
  });

  /**
   * The tie is the reason the watermark is a tuple. Two rows written in the
   * same millisecond order by id, so the position after reading both is the
   * second one's id — taking the maximum timestamp would pick one of the pair
   * and leave the other unreachable.
   */
  test("carries the id through a same-millisecond tie", () => {
    expect(first.createdAt).toEqual(second.createdAt);
    expect(nextWatermarkOf([first, second])).toEqual({
      createdAt: at,
      id: second.id,
    });
  });

  test("does not move on a conversation with nothing in it", () => {
    expect(nextWatermarkOf([])).toBeNull();
  });

  test("keeps the row's own id type, so the caller can store it", () => {
    const next = nextWatermarkOf([first]);
    const id: CommentId | undefined = next?.id;
    expect(id).toBe(first.id);
  });
});
