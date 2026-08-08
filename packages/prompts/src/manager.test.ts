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
  MANAGER_ANSWER_RULES,
  WORKSPACE_RULES,
  WRITING_RULES,
} from "./instructions";
import {
  buildManagerPrompt,
  FRESH_HISTORY_MESSAGES,
  renderChatMessage,
} from "./manager";
import type { PromptMode, RunPlacement } from "./render";
import {
  artifactRulesOf,
  MANAGER_RULES,
  SHARED_RULES,
  WORKER_RULES,
} from "./rules";

const threadId = newThreadId();

/**
 * What `threadPlacementOf` builds: a manager turn has no task and no project,
 * so its scratch directory is the only directory of its own it has, and it
 * points both fields at it. The shared directory is the one it may leave
 * anything in, and it sits above the scratch directory rather than beside it.
 */
const placement: RunPlacement = {
  artifactsDir: "/workspace/manager/scratch",
  branch: null,
  globalArtifactsDir: "/workspace",
  projectArtifactsDir: null,
  workspaceDir: "/workspace/manager/scratch",
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
  readonly instructionsOnDisk?: boolean;
  readonly messages: readonly ChatMessage[];
  readonly mode?: PromptMode;
}) =>
  buildManagerPrompt({
    historyLimit: input.historyLimit,
    instructionsOnDisk: input.instructionsOnDisk,
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
    // The seeded rules reach a turn from here whenever it has no tree to read
    // them from. A run never sees the operator's own `AGENTS.md`, and a mounted
    // skill's body is read only if the model invokes it, so neither is a place
    // to keep them.
    expect(text).toContain(WRITING_RULES);
    expect(text).toContain(MANAGER_ANSWER_RULES);
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
      "`/workspace/manager/scratch` is an empty scratch directory, yours to write, released when this run ends"
    );
    expect(text).toContain(
      "- `/workspace` is the shared directory every run reads."
    );
  });

  /**
   * The shared directory is read-only to a worker and writable to a manager,
   * and a placement carries no flag saying which. So the placement says nothing
   * about it here and the manager's own rules say what it may leave there — a
   * turn told the directory is read-only will not edit the house rules, which
   * is the point of giving it write access.
   */
  test("does not call the shared directory read-only to the one role that writes it", () => {
    const text = textOf({ messages: [message({ body: "hi", role: "user" })] });
    expect(text).not.toContain("every run reads. Read-only.");
    expect(text).toContain(
      "The shared directory every run reads is yours to write"
    );
  });

  test("never promises the scratch directory outlives the turn", () => {
    const text = textOf({ messages: [message({ body: "hi", role: "user" })] });
    expect(text).not.toContain("outlives the container");
    expect(text).not.toContain("is this task's directory");
  });

  /**
   * The bug this pair is about. A manager has no artifacts folder and no card,
   * so a prompt that hands it the worker's rules about either is describing a
   * run that does not exist — and the turn is spent explaining that it will not
   * post onto an unrelated card to satisfy a rule about one.
   */
  test("is told nothing about an artifacts folder it does not have", () => {
    const text = textOf({ messages: [message({ body: "hi", role: "user" })] });
    expect(text).not.toContain(
      artifactRulesOf({ hasProject: false, hasRepo: true })
    );
    expect(text).not.toContain(
      artifactRulesOf({ hasProject: false, hasRepo: false })
    );
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
    expect(text).not.toContain(WORKSPACE_RULES);
    expect(text).not.toContain(MANAGER_ANSWER_RULES);
    expect(text).not.toContain(placement.workspaceDir);
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

  test("a composed row says it is several messages to answer as one", () => {
    // The pieces carry their own headers inside the body; what the label adds
    // is that this is one thing to reply to rather than a person repeating
    // themselves three times.
    const rendered = renderChatMessage(
      message({
        body: "[message 1 of 2]\nfirst\n\n[message 2 of 2]\nsecond",
        intakeKind: "compose",
        role: "user",
      })
    );

    expect(rendered).toContain(
      "Person (several messages, sent together — answer them as one):"
    );
    expect(rendered).toContain("[message 2 of 2]");
  });

  test("the manager's own rows are labelled as its own", () => {
    expect(renderChatMessage(message({ body: "done", role: "manager" }))).toBe(
      "You: done"
    );
  });
});

describe("the rules", () => {
  /**
   * The tool table is the only list of tools, and this is what keeps it that
   * way. The rules used to open with all of them grouped in a bullet list, one
   * more spelling of names the model already reads off the table with a
   * description attached. What is quoted now is only a name carrying a policy,
   * so every one that appears has to be real.
   */
  const TOOL_PREFIXES = new Set(
    AGENT_TOOLS.map((tool) => tool.name.split("_")[0])
  );

  const named = new Set(
    [...MANAGER_RULES.matchAll(/`(\w+_\w+)`/g)]
      .map((match) => match[1] ?? "")
      // `in_progress` and `backlog` are columns, not tools, and they are quoted
      // here for the same reason a tool name is: the rule is about that exact
      // spelling.
      .filter((name) => TOOL_PREFIXES.has(name.split("_")[0] ?? ""))
  );

  test("name only tools that exist, and do not re-list the whole table", () => {
    const real = new Set(AGENT_TOOLS.map((tool) => tool.name));
    expect([...named].filter((name) => !real.has(name))).toEqual([]);
    expect(named.size).toBeLessThan(real.size);
  });

  test("say to file into backlog and never straight into in_progress", () => {
    expect(MANAGER_RULES).toContain("backlog");
    expect(MANAGER_RULES).toContain("in_progress");
  });

  test("say a delete is confirmed first and cannot be undone", () => {
    expect(MANAGER_RULES).toContain("tasks_delete");
    expect(MANAGER_RULES).toContain("no undo");
    expect(MANAGER_RULES).toContain("Ask before you call it");
  });

  test("say a move out of in_progress asks a live run to stop", () => {
    expect(MANAGER_RULES).toContain("asks that run to stop");
  });

  /**
   * How an answer is phrased is seeded on disk and editable there. The one line
   * of it that was board policy rather than phrasing — an answer that has grown
   * into a brief belongs on a card — is enforced by nothing else, so it stays
   * where the tool that files it is named.
   */
  test("keep the rule that an answer grown into a brief is filed as one", () => {
    expect(MANAGER_RULES).not.toContain("## How you answer");
    expect(MANAGER_RULES).toContain("it is a task brief. File it");
  });

  test("name no single window the conversation arrives through", () => {
    expect(MANAGER_RULES).not.toContain("Telegram");
  });

  /**
   * The sentence these replace said the opposite — "You have no shell, no
   * repository" — and stayed after the manager moved into a container, so a
   * turn asked to file a card about a repository guessed its URL from the
   * repositories of neighbouring projects rather than spending one `gh` call.
   * The claim is asserted in both directions because a prompt that is merely
   * silent about the shell produces the same guess.
   */
  test("say the shell and `gh` are there, and what they are for", () => {
    expect(MANAGER_RULES).not.toContain("You have no shell");
    expect(MANAGER_RULES).toContain("`gh` logged in");
    expect(MANAGER_RULES).toContain("default branch before you name them");
  });

  test("say the shell is for reading and the work still belongs on a card", () => {
    expect(MANAGER_RULES).toContain("It is not there to do the work");
    expect(MANAGER_RULES).toContain(
      "do not commit, push, or open a pull request"
    );
    expect(MANAGER_RULES).toContain("file the card");
  });

  test("say the working directory does not outlive the turn", () => {
    expect(MANAGER_RULES).toContain(
      "Your working directory is deleted when this turn ends"
    );
    expect(MANAGER_RULES).not.toContain("outlives the container");
  });

  /**
   * The rule this replaced said `/workspace` was scratch. It stopped being true
   * when the workspace scope became the shared directory every run reads, and a
   * manager that believes its one writable path is thrown away will not edit
   * the house rules a worker is handed.
   */
  test("say the shared directory is theirs to write, and that an edit reaches every later run", () => {
    expect(MANAGER_RULES).not.toContain("is scratch");
    expect(MANAGER_RULES).toContain(
      "The shared directory every run reads is yours to write"
    );
    expect(MANAGER_RULES).toContain("an edit changes every run after this one");
  });

  /**
   * A rule is one string for every mode; the paths are per run, and a local
   * turn's are host directories with no `/workspace` anywhere. A path named here
   * would send that turn to write somewhere that does not exist — so the rules
   * describe the directories and `placementSection` names them.
   */
  test("name no container path, leaving the paths to the placement section", () => {
    expect(MANAGER_RULES).not.toContain("/workspace");
  });
});

/**
 * The prompt carries the seeded rules exactly when the filesystem cannot. A
 * container turn reads the same text out of the workspace document and its own
 * `manager/AGENTS.md`; a local turn is a host process with nothing above it, so
 * dropping them there would lose them silently.
 */
describe("the seeded rules, on disk or in the prompt", () => {
  const messages = [message({ body: "hi", role: "user" })];

  test("states both documents when the turn has no tree to read them from", () => {
    const text = textOf({ instructionsOnDisk: false, messages });
    expect(text).toContain(WORKSPACE_RULES);
    expect(text).toContain(MANAGER_ANSWER_RULES);
    // A caller that has not been updated is that case, so silence means stated.
    expect(textOf({ messages })).toContain(WORKSPACE_RULES);
  });

  /**
   * Root-down, deepest last, which is how both CLIs concatenate the files
   * themselves — so the manager's own answering rules still win by position
   * over the house style every role reads.
   */
  test("states them in the order the tree would have handed them over", () => {
    const text = textOf({ messages });
    expect(text.indexOf(WORKSPACE_RULES)).toBeLessThan(
      text.indexOf(MANAGER_ANSWER_RULES)
    );
  });

  test("leaves them out when the directories carry them", () => {
    const text = textOf({ instructionsOnDisk: true, messages });
    expect(text).not.toContain(WORKSPACE_RULES);
    expect(text).not.toContain("## How you write");
    expect(text).not.toContain("## How you answer");
    // Only those blocks. Board policy is not a thing a file on disk can promise.
    expect(text).toContain(MANAGER_RULES);
    expect(text).toContain(SHARED_RULES);
  });
});
