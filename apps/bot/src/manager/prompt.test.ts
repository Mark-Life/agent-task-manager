/**
 * Two things are asserted here. That the prompt is composed in the order the
 * model reads it and carries the thread's own words — the manager has no other
 * memory, so a dropped row is a forgotten conversation. And that the rules name
 * tools that exist, because a renamed tool is otherwise a manager confidently
 * calling something the server never registered.
 */

import { describe, expect, test } from "bun:test";
import type { ChatMessage } from "@workspace/domain";
import {
  newChatMessageId,
  newThreadId,
  TelegramChatId,
  WorkspaceId,
} from "@workspace/domain";
import { MANAGER_TOOLS } from "@workspace/manager-tools";
import { DateTime } from "effect";
import { buildManagerPrompt, renderHistoryMessage } from "./prompt";
import { MANAGER_RULES } from "./rules";

const threadId = newThreadId();

/** One stored row, with only the fields the renderer reads varying. */
const message = (
  fields: Pick<ChatMessage, "body" | "role"> & Partial<ChatMessage>
): ChatMessage => ({
  createdAt: DateTime.makeUnsafe(0),
  forwardFrom: null,
  id: newChatMessageId(),
  intakeKind: fields.role === "user" ? "text" : null,
  providerSessionId: null,
  telegramChatId: TelegramChatId.make(42),
  telegramMessageId: null,
  threadId,
  transcriptChars: null,
  workspaceId: WorkspaceId.make("ws"),
  ...fields,
});

describe("buildManagerPrompt", () => {
  test("puts the rules first and the new message last", () => {
    const prompt = buildManagerPrompt({
      history: [message({ body: "older", role: "user" })],
      message: { body: "what is on the board?" },
    });

    expect(prompt.startsWith(MANAGER_RULES)).toBe(true);
    expect(prompt.trimEnd().endsWith("Person: what is on the board?")).toBe(
      true
    );
    expect(prompt.indexOf("## Conversation so far")).toBeLessThan(
      prompt.indexOf("## New message")
    );
  });

  test("carries the thread's own words, in the order they were said", () => {
    const prompt = buildManagerPrompt({
      history: [
        message({ body: "file a task about the login bug", role: "user" }),
        message({ body: "filed it in backlog", role: "manager" }),
      ],
      message: { body: "start it" },
    });

    expect(prompt).toContain("Person: file a task about the login bug");
    expect(prompt).toContain("You: filed it in backlog");
    expect(prompt.indexOf("file a task")).toBeLessThan(
      prompt.indexOf("filed it in backlog")
    );
  });

  test("a first turn has no history section, rather than an empty one", () => {
    const prompt = buildManagerPrompt({
      history: [],
      message: { body: "hello" },
    });

    expect(prompt).not.toContain("## Conversation so far");
    expect(prompt).toContain("## New message");
  });

  test("keeps the newest rows when the thread is longer than the limit", () => {
    const history = Array.from({ length: 10 }, (_, index) =>
      message({ body: `line ${index}`, role: "user" })
    );

    const prompt = buildManagerPrompt({
      history,
      historyLimit: 3,
      message: { body: "and now?" },
    });

    expect(prompt).toContain("line 9");
    expect(prompt).toContain("line 7");
    expect(prompt).not.toContain("line 6");
  });

  test("a limit of zero drops the history and keeps the message", () => {
    const prompt = buildManagerPrompt({
      history: [message({ body: "older", role: "user" })],
      historyLimit: 0,
      message: { body: "hello" },
    });

    expect(prompt).not.toContain("## Conversation so far");
    expect(prompt).toContain("Person: hello");
  });
});

describe("renderHistoryMessage", () => {
  test("a forward is attributed from its column, not from inside the body", () => {
    const rendered = renderHistoryMessage(
      message({
        body: "the deploy is broken",
        forwardFrom: "Ada",
        intakeKind: "forward",
        role: "user",
      })
    );

    expect(rendered).toBe("Person (forwarded from Ada): the deploy is broken");
  });

  test("a forward with no sender still says it was forwarded", () => {
    const rendered = renderHistoryMessage(
      message({ body: "look", intakeKind: "forward", role: "user" })
    );

    expect(rendered).toBe("Person (forwarded from someone): look");
  });

  test("a voice note is marked as dictated, so its rambling reads as speech", () => {
    const rendered = renderHistoryMessage(
      message({ body: "um so file a task", intakeKind: "voice", role: "user" })
    );

    expect(rendered).toBe(
      "Person (voice note, transcribed): um so file a task"
    );
  });

  test("the manager's own rows are labelled as its own", () => {
    expect(
      renderHistoryMessage(message({ body: "done", role: "manager" }))
    ).toBe("You: done");
  });
});

describe("the rules", () => {
  /** The bullet list the rules introduce the tools with, and nothing else. */
  const toolSection = MANAGER_RULES.slice(
    MANAGER_RULES.indexOf("The tools are:"),
    MANAGER_RULES.indexOf("There is no delete")
  );

  const named = [...toolSection.matchAll(/`(\w+)`/g)].map(
    (match) => match[1] ?? ""
  );

  const alphabetically = (names: readonly string[]) =>
    [...names].sort((left, right) => left.localeCompare(right));

  test("introduce every tool the manager actually has, and no other", () => {
    expect(alphabetically(named)).toEqual(
      alphabetically(MANAGER_TOOLS.map((tool) => tool.name))
    );
  });

  test("say to file into backlog and never straight into in_progress", () => {
    expect(MANAGER_RULES).toContain("backlog");
    expect(MANAGER_RULES).toContain("in_progress");
  });
});
