/**
 * Where a conversation stands from the chat looking at it.
 *
 * The list `/threads` draws is the workspace's, so a row on it may be one this
 * chat opened, one the dashboard opened, or one another chat is holding — and
 * the marker is the only thing telling them apart before a tap. These are the
 * cases that decide it.
 */

import { describe, expect, test } from "bun:test";
import type { ChatThread } from "@workspace/domain";
import { TelegramChatId } from "@workspace/domain";
import { DateTime } from "effect";
import {
  THREAD_RELATION_MARKERS,
  threadButtonLabel,
  threadRelation,
} from "./threads";

const NOW = DateTime.makeUnsafe("2026-08-02T12:00:00.000Z");
const HERE = TelegramChatId.make(-1_001_234);
const ELSEWHERE = TelegramChatId.make(4321);

/** One row of the list, with only the columns a label reads. */
const threadWith = (
  fields: Partial<Pick<ChatThread, "chatId" | "isCurrent" | "title">>
) => ({
  chatId: HERE,
  isCurrent: false,
  lastMessageAt: DateTime.makeUnsafe("2026-08-02T11:00:00.000Z"),
  title: "rename the deploy script",
  ...fields,
});

describe("threadRelation", () => {
  test.each([
    ["this chat's current one", { isCurrent: true }, "current"],
    ["this chat's, put aside", { isCurrent: false }, "here"],
    ["opened in the dashboard", { chatId: null }, "dashboard"],
    // Opened over HTTP, so `is_current` is set on a thread that is current in
    // no chat at all. It is still the dashboard's until somebody resumes it.
    [
      "opened in the dashboard and never resumed",
      { chatId: null, isCurrent: true },
      "dashboard",
    ],
    ["another chat's", { chatId: ELSEWHERE, isCurrent: true }, "elsewhere"],
  ] as const)("calls %s %s", (_name, fields, expected) => {
    expect(threadRelation({ chatId: HERE, thread: threadWith(fields) })).toBe(
      expected
    );
  });
});

describe("threadButtonLabel", () => {
  test("marks the current conversation and nothing else of this chat's", () => {
    expect(
      threadButtonLabel({
        chatId: HERE,
        now: NOW,
        thread: threadWith({ isCurrent: true }),
      })
    ).toBe(
      `${THREAD_RELATION_MARKERS.current} rename the deploy script · 1h ago`
    );

    expect(
      threadButtonLabel({ chatId: HERE, now: NOW, thread: threadWith({}) })
    ).toBe("rename the deploy script · 1h ago");
  });

  test("says on the button where a conversation was opened", () => {
    expect(
      threadButtonLabel({
        chatId: HERE,
        now: NOW,
        thread: threadWith({ chatId: null, title: "from the dashboard" }),
      })
    ).toBe(`${THREAD_RELATION_MARKERS.dashboard} from the dashboard · 1h ago`);

    expect(
      threadButtonLabel({
        chatId: HERE,
        now: NOW,
        thread: threadWith({ chatId: ELSEWHERE, title: "somebody else's" }),
      })
    ).toBe(`${THREAD_RELATION_MARKERS.elsewhere} somebody else's · 1h ago`);
  });

  test("falls back to a placeholder for a conversation nothing was said in", () => {
    expect(
      threadButtonLabel({
        chatId: HERE,
        now: NOW,
        thread: threadWith({ title: null }),
      })
    ).toBe("(untitled) · 1h ago");
  });
});
