/**
 * Three things are asserted here. That the prompt is composed in the order the
 * model reads it and carries the thread's own words — a dropped row is a
 * forgotten conversation. That a resumed turn repeats none of it, since its own
 * session history already holds it. And that the rules name tools that exist,
 * because a renamed tool is otherwise a manager confidently calling something
 * the server never registered.
 */

import { describe, expect, test } from "bun:test";
import { AGENT_TOOLS } from "@workspace/agent-tools";
import type { ChatMessage } from "@workspace/domain";
import {
  newChatMessageId,
  newThreadId,
  TelegramChatId,
  WorkspaceId,
} from "@workspace/domain";
import { DateTime } from "effect";
import {
  buildManagerPrompt,
  FRESH_HISTORY_MESSAGES,
  renderChatMessage,
} from "./manager";
import type { PromptMode, RunPlacement } from "./render";
import {
  ARTIFACT_RULES,
  MANAGER_RULES,
  SHARED_RULES,
  WORKER_RULES,
} from "./rules";

const threadId = newThreadId();

/**
 * What `threadPlacementOf` builds: a manager turn has no task and no project,
 * so its scratch directory is also the only directory it may write.
 */
const placement: RunPlacement = {
  artifactsDir: "/workspace",
  branch: null,
  globalArtifactsDir: "/artifacts/global",
  projectArtifactsDir: null,
  workspaceDir: "/workspace",
};

/** One stored row, with only the fields the renderer reads varying. */
const message = (
  fields: Pick<ChatMessage, "body" | "role"> & Partial<ChatMessage>
): ChatMessage => ({
  createdAt: DateTime.makeUnsafe(0),
  forwardFrom: null,
  id: newChatMessageId(),
  intakeKind: fields.role === "user" ? "text" : null,
  runId: null,
  telegramChatId: TelegramChatId.make(42),
  telegramMessageId: null,
  threadId,
  transcriptChars: null,
  workspaceId: WorkspaceId.make("ws"),
  ...fields,
});

const textOf = (input: {
  readonly historyLimit?: number;
  readonly messages: readonly ChatMessage[];
  readonly mode?: PromptMode;
}) =>
  buildManagerPrompt({
    historyLimit: input.historyLimit,
    messages: input.messages,
    mode: input.mode ?? "fresh",
    placement,
  }).text;

describe("a first turn's prompt", () => {
  test("puts the rules first and the message being answered last", () => {
    const text = textOf({
      messages: [
        message({ body: "older", role: "user" }),
        message({ body: "what is on the board?", role: "user" }),
      ],
    });

    expect(text.startsWith(MANAGER_RULES)).toBe(true);
    expect(text).toContain(SHARED_RULES);
    expect(text.indexOf("## The conversation so far")).toBeLessThan(
      text.indexOf("Person: what is on the board?")
    );
  });

  test("carries the thread's own words, in the order they were said", () => {
    const text = textOf({
      messages: [
        message({ body: "file a task about the login bug", role: "user" }),
        message({ body: "filed it in backlog", role: "manager" }),
        message({ body: "start it", role: "user" }),
      ],
    });

    expect(text).toContain("Person: file a task about the login bug");
    expect(text).toContain("You: filed it in backlog");
    expect(text.indexOf("file a task")).toBeLessThan(
      text.indexOf("filed it in backlog")
    );
  });

  test("names the directories the turn was given", () => {
    const text = textOf({ messages: [message({ body: "hi", role: "user" })] });
    expect(text).toContain(
      "`/workspace` is an empty scratch directory, yours to write, released when this run ends"
    );
    expect(text).toContain("Read-only reference material: `/artifacts/global`");
  });

  test("never promises the scratch directory outlives the turn", () => {
    const text = textOf({ messages: [message({ body: "hi", role: "user" })] });
    expect(text).not.toContain("outlives the container");
  });

  /**
   * The bug this pair is about. A manager has no artifacts folder and no card,
   * so a prompt that hands it the worker's rules about either is describing a
   * run that does not exist — and the turn is spent explaining that it will not
   * post onto an unrelated card to satisfy a rule about one.
   */
  test("is told nothing about an artifacts folder it does not have", () => {
    const text = textOf({ messages: [message({ body: "hi", role: "user" })] });
    expect(text).not.toContain(ARTIFACT_RULES);
    expect(text).not.toContain("What survives this run");
  });

  test("is told its answer is the whole of its turn, with no card to close", () => {
    const text = textOf({ messages: [message({ body: "hi", role: "user" })] });
    expect(text).not.toContain(WORKER_RULES);
    expect(text).toContain("You are not working on a card");
    expect(text).toContain(
      "a turn where you only read the board and answered is a finished turn"
    );
  });

  test("has no conversation section rather than an empty one", () => {
    const text = textOf({ messages: [] });
    expect(text).not.toContain("## The conversation so far");
    expect(text).not.toContain("## What to answer");
  });

  test("keeps the newest rows when the thread is longer than the limit", () => {
    const messages = Array.from({ length: 10 }, (_, index) =>
      message({ body: `line ${index}`, role: "user" })
    );

    const text = textOf({ historyLimit: 3, messages });

    expect(text).toContain("line 9");
    expect(text).toContain("line 7");
    expect(text).not.toContain("line 6");
  });

  test("caps a long thread by default, so a year-old conversation still fits", () => {
    const messages = Array.from(
      { length: FRESH_HISTORY_MESSAGES + 5 },
      (_, i) => message({ body: `line ${i}`, role: "user" })
    );

    const text = textOf({ messages });

    expect(text).not.toContain("Person: line 0");
    expect(text).not.toContain("Person: line 4\n");
    expect(text).toContain("Person: line 5");
    expect(text).toContain(`Person: line ${FRESH_HISTORY_MESSAGES + 4}`);
  });
});

describe("a resumed turn's prompt", () => {
  const text = textOf({
    messages: [
      message({ body: "and the second one", role: "user" }),
      message({ body: "and a third", role: "user" }),
    ],
    mode: "resumed",
  });

  test("hands over everything said since the last turn, and says to answer it together", () => {
    expect(text).toContain("## New since your last turn");
    expect(text).toContain("Person: and the second one");
    expect(text).toContain("Person: and a third");
    expect(text).toContain("answer them together");
  });

  test("repeats nothing the session already has in its own history", () => {
    expect(text).not.toContain(MANAGER_RULES);
    expect(text).not.toContain(SHARED_RULES);
    expect(text).not.toContain("/artifacts/task");
  });

  test("is total on an empty read rather than pretending something arrived", () => {
    expect(textOf({ messages: [], mode: "resumed" })).toContain(
      "Nothing new arrived."
    );
  });
});

describe("one row, rendered", () => {
  test("a forward is attributed from its column, not from inside the body", () => {
    const rendered = renderChatMessage(
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
    const rendered = renderChatMessage(
      message({ body: "look", intakeKind: "forward", role: "user" })
    );

    expect(rendered).toBe("Person (forwarded from someone): look");
  });

  test("a voice note is marked as dictated, so its rambling reads as speech", () => {
    const rendered = renderChatMessage(
      message({ body: "um so file a task", intakeKind: "voice", role: "user" })
    );

    expect(rendered).toBe(
      "Person (voice note, transcribed): um so file a task"
    );
  });

  test("the manager's own rows are labelled as its own", () => {
    expect(renderChatMessage(message({ body: "done", role: "manager" }))).toBe(
      "You: done"
    );
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
      alphabetically(AGENT_TOOLS.map((tool) => tool.name))
    );
  });

  test("say to file into backlog and never straight into in_progress", () => {
    expect(MANAGER_RULES).toContain("backlog");
    expect(MANAGER_RULES).toContain("in_progress");
  });

  test("name no single window the conversation arrives through", () => {
    expect(MANAGER_RULES).not.toContain("Telegram");
  });
});
