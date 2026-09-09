/**
 * The two rules that decide whether a card costs GitHub a request, asserted
 * without a database and without a network.
 *
 * They are worth their own test because both are about *not* asking, and a
 * mistake in either is invisible: a board that quietly re-asks about every
 * merged pull request every ten seconds looks exactly like one that does not,
 * right up until the hour's allowance is gone.
 */

import { describe, expect, test } from "bun:test";
import type { Task } from "@workspace/domain";
import { newTaskId, type WorkspaceId } from "@workspace/domain";
import { DateTime } from "effect";
import { freshestAt, isRefreshable, REFRESH_TTL_MS } from "./pr-state";

const NOW = DateTime.makeUnsafe("2026-09-09T12:00:00.000Z");

const task = (fields: Partial<Task>): Task => ({
  acceptance: null,
  brief: "",
  createdAt: NOW,
  dispatchTraceparent: null,
  id: newTaskId(),
  metadata: {},
  nextSessionId: null,
  nextSessionNew: false,
  parentTaskId: null,
  parkedUntil: null,
  projectId: null,
  prState: null,
  prStateAt: null,
  prUrl: null,
  rank: 0,
  repoUrl: null,
  sandboxImage: null,
  status: "review",
  statusChangedAt: NOW,
  title: "A card",
  updatedAt: NOW,
  workspaceId: "8f6ba3cc0d2a4a0f9b1f7e2c5d3a6b41" as WorkspaceId,
  ...fields,
});

const PR_URL = "https://github.com/acme/widgets/pull/7";

describe("isRefreshable", () => {
  /** Most of a board. Nothing to ask about, so nothing is asked. */
  test("skips a card with no pull request", () => {
    expect(isRefreshable(task({}))).toBe(false);
  });

  test("asks about a pull request that is live, whether or not a state is known", () => {
    expect(isRefreshable(task({ prUrl: PR_URL }))).toBe(true);
    expect(isRefreshable(task({ prState: "draft", prUrl: PR_URL }))).toBe(true);
    expect(isRefreshable(task({ prState: "open", prUrl: PR_URL }))).toBe(true);
  });

  /**
   * The rule that makes the cost of this feature fall over time rather than
   * grow with the board: a card whose pull request shipped is out of the loop
   * for good, and `done` is where most cards end up.
   */
  test("stops for good once the pull request is merged or closed", () => {
    expect(isRefreshable(task({ prState: "merged", prUrl: PR_URL }))).toBe(
      false
    );
    expect(isRefreshable(task({ prState: "closed", prUrl: PR_URL }))).toBe(
      false
    );
  });

  /** `pr_url` is free text, and a link to something else must cost no request. */
  test("skips a link that is not a pull request", () => {
    expect(
      isRefreshable(task({ prUrl: "https://github.com/acme/widgets/issues/7" }))
    ).toBe(false);
    expect(isRefreshable(task({ prUrl: "see the thread" }))).toBe(false);
  });
});

describe("freshestAt", () => {
  const withStamp = (minutesAgo: number) =>
    task({
      prState: "open",
      prStateAt: DateTime.subtract(NOW, { minutes: minutesAgo }),
      prUrl: PR_URL,
    });

  /**
   * The restart case. A gateway that has just come up remembers no checks, and
   * without the row's own stamp every card on the first board read would be
   * re-asked for an answer that is a minute old.
   */
  test("falls back to the stamp on the row when nothing was checked this process", () => {
    const at = freshestAt({ checked: undefined, task: withStamp(1) });
    expect(DateTime.toEpochMillis(NOW) - at).toBeLessThan(REFRESH_TTL_MS);
  });

  /**
   * The steady state. The row is written only when the state changes, so a pull
   * request that has been open for a week has a week-old stamp and has still
   * been checked a minute ago — the check is what has to win, or every open
   * pull request would be asked about on every single board poll.
   */
  test("prefers a recent check over an old stamp", () => {
    const checkedAt = DateTime.toEpochMillis(
      DateTime.subtract(NOW, { seconds: 30 })
    );
    const at = freshestAt({
      checked: { checkedAt, etag: 'W/"abc"' },
      task: withStamp(60 * 24 * 7),
    });
    expect(at).toBe(checkedAt);
  });

  /** A card nothing is known about is due immediately, which is the first read. */
  test("is zero for a card with no answer and no check", () => {
    expect(
      freshestAt({ checked: undefined, task: task({ prUrl: PR_URL }) })
    ).toBe(0);
  });
});
