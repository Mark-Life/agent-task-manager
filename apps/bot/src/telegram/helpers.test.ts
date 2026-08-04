import { describe, expect, test } from "bun:test";
import { DateTime } from "effect";
import type { Context } from "grammy";
import {
  buildPromptWithReplyContext,
  escapeHtml,
  formatDuration,
  formatRelativeTime,
  forwardSenderName,
} from "./helpers";

const NOW = DateTime.makeUnsafe("2026-08-02T12:00:00.000Z");

/** A context carrying only the message fields the function under test reads. */
const contextWith = (message: unknown) => ({ message }) as unknown as Context;

describe("escapeHtml", () => {
  test("escapes the three characters Telegram treats as markup", () => {
    expect(escapeHtml('<b>&"</b>')).toBe('&lt;b&gt;&amp;"&lt;/b&gt;');
  });

  test("escapes the ampersand first, so an escape is not double-escaped", () => {
    expect(escapeHtml("&lt;")).toBe("&amp;lt;");
  });
});

describe("forwardSenderName", () => {
  test.each([
    ["user", { sender_user: { first_name: "Ada" }, type: "user" }, "Ada"],
    ["channel", { chat: { title: "Releases" }, type: "channel" }, "Releases"],
    [
      "hidden_user",
      { sender_user_name: "Someone", type: "hidden_user" },
      "Someone",
    ],
    ["chat", { sender_chat: {}, type: "chat" }, "unknown"],
  ])("names a %s origin", (_name, origin, expected) => {
    expect(
      forwardSenderName(origin as Parameters<typeof forwardSenderName>[0])
    ).toBe(expected);
  });
});

describe("buildPromptWithReplyContext", () => {
  test("returns the text unchanged when nothing was replied to", () => {
    expect(
      buildPromptWithReplyContext({
        botId: 1,
        ctx: contextWith({}),
        text: "hi",
      })
    ).toBe("hi");
  });

  test("prepends the replied-to text", () => {
    const built = buildPromptWithReplyContext({
      botId: 1,
      ctx: contextWith({
        reply_to_message: { from: { id: 9 }, text: "ship it" },
      }),
      text: "do that",
    });
    expect(built).toBe("[Replying to: ship it]\n\ndo that");
  });

  test("skips the bot's own message", () => {
    const built = buildPromptWithReplyContext({
      botId: 9,
      ctx: contextWith({
        reply_to_message: { from: { id: 9 }, text: "ship it" },
      }),
      text: "do that",
    });
    expect(built).toBe("do that");
  });

  test("truncates a very long quote", () => {
    const built = buildPromptWithReplyContext({
      botId: null,
      ctx: contextWith({ reply_to_message: { text: "x".repeat(5000) } }),
      text: "do that",
    });
    expect(built.length).toBeLessThan(2100);
    expect(built).toContain("...");
  });
});

describe("formatRelativeTime", () => {
  test.each([
    ["just now", 0],
    ["5m ago", 5],
    ["2h ago", 120],
    ["3d ago", 3 * 24 * 60],
  ])("renders %s", (expected, minutesAgo) => {
    const at = DateTime.subtract(NOW, { minutes: minutesAgo });
    expect(formatRelativeTime({ at, now: NOW })).toBe(expected);
  });

  test("degrades to a date past a week", () => {
    const at = DateTime.subtract(NOW, { days: 30 });
    expect(formatRelativeTime({ at, now: NOW })).toBe("Jul 3");
  });
});

describe("formatDuration", () => {
  test("passes null through rather than inventing a zero", () => {
    expect(formatDuration(null)).toBeNull();
  });

  test("renders seconds under a minute", () => {
    expect(formatDuration(1500)).toBe("1.5s");
  });

  test("renders minutes and seconds past one", () => {
    expect(formatDuration(95_000)).toBe("1m 35s");
  });
});
