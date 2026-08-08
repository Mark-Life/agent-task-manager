/**
 * The worker's half of the assembly, which is pure: every shape it can produce
 * — the fresh briefing, the resumed delta, the labels that tell one session's
 * voice from another's — is checked against rows built in this file with no
 * database in sight.
 *
 * What is not here is the walk that proves the watermark advances against real
 * Postgres ordering. That belongs to the impure wrapper and stays beside it in
 * `@workspace/orchestrator`.
 */

import { describe, expect, test } from "bun:test";
import {
  HANDOFF_FILENAME,
  newAgentSessionId,
  newProjectId,
  newTaskId,
  newTaskMessageId,
  type Project,
  type Task,
  type TaskMessage,
  UserId,
  WorkspaceId,
} from "@workspace/domain";
import { DateTime } from "effect";
import {
  MESSAGE_SHAPE_RULES,
  WORKSPACE_RULES,
  WRITING_RULES,
} from "./instructions";
import type { PromptMode, RunPlacement } from "./render";
import { artifactRulesOf, CREDENTIAL_RULES, SHARED_RULES } from "./rules";
import { buildWorkerPrompt, messageLabelOf } from "./worker";

const at = DateTime.makeUnsafe("2026-08-02T10:00:00.000Z");
const workspaceId = WorkspaceId.make("ws-1");
const userId = UserId.make("user-1");
const taskId = newTaskId();
const sessionId = newAgentSessionId();
const otherSessionId = newAgentSessionId();

const task: Task = {
  acceptance: "the endpoint returns 204 and the row is gone",
  brief: "delete the thing when the user asks for it",
  createdAt: at,
  dispatchTraceparent: null,
  id: taskId,
  metadata: {},
  nextSessionId: null,
  nextSessionNew: false,
  parentTaskId: null,
  parkedUntil: null,
  projectId: null,
  prUrl: null,
  rank: 0,
  repoUrl: "https://github.com/acme/widgets",
  sandboxImage: null,
  status: "in_progress",
  statusChangedAt: at,
  title: "Delete endpoint",
  updatedAt: at,
  workspaceId,
};

const project: Project = {
  createdAt: at,
  description: "the widget shop",
  id: newProjectId(),
  name: "Widgets",
  repoDefaultBranch: "main",
  repoUrl: "https://github.com/acme/widgets",
  updatedAt: at,
  workspaceId,
};

/**
 * The full tree: shared, project, task, checkout, each inside the one before
 * it. Written out as literal paths rather than joined from segments, because
 * the nesting is the thing under test and a helper that builds it would agree
 * with itself whatever it produced.
 */
const placement: RunPlacement = {
  artifactsDir: "/workspace/worker/widgets/delete-endpoint",
  branch: "atm/task-1",
  globalArtifactsDir: "/workspace",
  projectArtifactsDir: "/workspace/worker/widgets",
  workspaceDir: "/workspace/worker/widgets/delete-endpoint/acme-widgets",
};

/** The same run with nothing to clone: the working directory is a scratch directory inside the task's. */
const noRepoPlacement: RunPlacement = {
  ...placement,
  branch: null,
  workspaceDir: "/workspace/worker/widgets/delete-endpoint/scratch",
};

/** No project and no repo, so the middle level is skipped and the tree is one shorter. */
const barePlacement: RunPlacement = {
  artifactsDir: "/workspace/worker/delete-endpoint",
  branch: null,
  globalArtifactsDir: "/workspace",
  projectArtifactsDir: null,
  workspaceDir: "/workspace/worker/delete-endpoint/scratch",
};

/** A message on the fixture task, with only the fields a prompt reads spelled out. */
const messageOf = (
  input: Partial<TaskMessage> & Pick<TaskMessage, "body">
): TaskMessage => ({
  agentSessionId: null,
  authorKind: "human",
  authorUserId: userId,
  createdAt: at,
  id: newTaskMessageId(),
  kind: "message",
  runId: null,
  taskId,
  updatedAt: at,
  workspaceId,
  ...input,
});

const promptOf = (input: {
  readonly instructionsOnDisk?: boolean;
  readonly messages?: readonly TaskMessage[];
  readonly mode?: PromptMode;
  readonly placement?: RunPlacement;
  readonly project?: Project | null;
  readonly repoUrl?: string | null;
}) =>
  buildWorkerPrompt({
    instructionsOnDisk: input.instructionsOnDisk,
    messages: input.messages ?? [],
    mode: input.mode ?? "fresh",
    placement: input.placement ?? placement,
    project: input.project === undefined ? project : input.project,
    readerSessionId: sessionId,
    repoUrl: input.repoUrl === undefined ? task.repoUrl : input.repoUrl,
    task,
  });

const textOf = (input: Parameters<typeof promptOf>[0]) => promptOf(input).text;

describe("a fresh session's prompt", () => {
  const built = promptOf({});
  const { text } = built;

  test("situates the run in the task it was dispatched for", () => {
    expect(text).toContain("# Delete endpoint");
    expect(text).toContain("delete the thing when the user asks for it");
    expect(text).toContain("the endpoint returns 204 and the row is gone");
    expect(text).toContain("Widgets — the widget shop");
  });

  test("names the checkout, its branch, and what to do with it", () => {
    expect(text).toContain("`https://github.com/acme/widgets` is cloned at");
    expect(text).toContain("on branch `atm/task-1`");
    expect(text).toContain("open a pull request");
  });

  /**
   * The rule that replaced a workaround. A run whose push was refused for a
   * missing scope saved the blocked half as a patch file and opened a pull
   * request with the rest, and the pull request read as complete — so the
   * instruction has to reach the run that has a repository to push.
   */
  test("tells a run with a repository what its credential is and what a refusal means", () => {
    expect(text).toContain(CREDENTIAL_RULES);
    expect(text).toContain("gh auth status");
    expect(text).toContain("which scope or permission the refusal named");
  });

  test("names every level of the tree, what each is for, and states the rule once", () => {
    expect(text).toContain(
      "- `/workspace/worker/widgets/delete-endpoint` is this task's directory, yours to write, and what you leave there outlives the container."
    );
    expect(text).toContain(
      "- `/workspace/worker/widgets` is this project's directory, yours to write, and shared with every task in it."
    );
    expect(text).toContain(
      "- `/workspace` is the shared directory every run reads. Read-only."
    );
    expect(text).toContain(
      artifactRulesOf({ hasProject: true, hasRepo: true })
    );
    expect(text).toContain(SHARED_RULES);
    // The seeded rules reach both roles from the prompt whenever the run has no
    // tree to read them from, which is what `instructionsOnDisk` decides.
    expect(text).toContain(WORKSPACE_RULES);
  });

  /**
   * The paths are what carry the scoping: each level sits inside the one above
   * it, which is what puts a `CLAUDE.md` or `AGENTS.md` at every level on the
   * path both providers walk up from the working directory. A prompt naming
   * four unrelated directories would describe a system that does not load them.
   */
  test("spells the four directories as one path, innermost last", () => {
    expect(
      placement.workspaceDir.startsWith(`${placement.artifactsDir}/`)
    ).toBe(true);
    expect(
      placement.artifactsDir.startsWith(`${placement.projectArtifactsDir}/`)
    ).toBe(true);
    expect(
      placement.projectArtifactsDir?.startsWith(
        `${placement.globalArtifactsDir}/`
      )
    ).toBe(true);
    expect(text.indexOf(placement.workspaceDir)).toBeLessThan(
      text.indexOf(`- \`${placement.artifactsDir}\``)
    );
  });

  /**
   * The rules used to describe the project directory as read-only reference
   * material, because the mount was. It is read-write now, and a run told the
   * opposite files a document for the next task on the project into its own
   * task directory, where that task never looks.
   */
  test("says what the project directory is for, now that a run may write it", () => {
    expect(text).toContain(
      "The project directory is durable material a later task on the same project reads"
    );
    expect(text).toContain("The task directory is this run's own output.");
    expect(text).toContain(
      "The shared directory is reference material for every run, and you cannot write it."
    );
  });

  test("leaves the project level out of the rules for a task that has no project", () => {
    const bare = textOf({
      placement: barePlacement,
      project: null,
      repoUrl: null,
    });
    expect(bare).toContain("The task directory is this run's own output.");
    expect(bare).not.toContain("The project directory is durable material");
    expect(bare).not.toContain("is this project's directory");
  });

  /**
   * The rule that replaced a duplicate. A spike run committed its findings
   * document, opened a pull request with it, and copied the same bytes into its
   * artifacts folder — because it had been told anything worth keeping goes
   * there, and it was right about the document being worth keeping. So the
   * folder has to be described by what it is *for* rather than by how valuable
   * its contents are.
   */
  test("sends a document that belongs in a pull request to the pull request only", () => {
    expect(text).toContain("output that has nowhere else to live");
    expect(text).toContain(
      "Do not write a second copy into the task directory"
    );
    // And the honest exception: committed work with no pull request behind it
    // has nothing else holding it, so the artifacts copy is the right hedge.
    expect(text).toContain("no pull request stands behind it");
    expect(text).toContain("name the branch it is also on");
    // The sentence the duplicate was obeying is gone from this run's copy, not
    // merely qualified.
    expect(text).not.toContain(
      "Anything worth keeping goes in the task directory"
    );
  });

  /**
   * The checkout used to be a sibling of the artifacts folder and is now a
   * child of the task directory. A run reading that the task directory outlives
   * the container, and seeing its checkout inside it, can leave a file in the
   * checkout instead of pushing it and lose it with the container.
   */
  test("says the checkout inside the task directory does not share its lifetime", () => {
    expect(text).toContain(
      "Your checkout sits inside it and is not part of it"
    );
    expect(text).toContain("anything you did not push is gone");
  });

  test("keeps the pull request out of it for a run that has no repository", () => {
    // The carve-out is about a better home for a document. A run with no
    // repository has no such home, so it gets the plain rule and is not sent
    // looking for a pull request it cannot open.
    const scratch = textOf({ placement: noRepoPlacement, repoUrl: null });
    expect(scratch).toContain(
      artifactRulesOf({ hasProject: true, hasRepo: false })
    );
    expect(scratch).toContain(
      "Anything worth keeping goes in the task directory"
    );
    expect(scratch).not.toContain(
      "Do not write a second copy into the task directory"
    );
  });

  test("teaches the rule the stop hook enforces", () => {
    expect(text).toContain("post a message on this task");
    expect(text).toContain("sent back to write it");
  });

  /**
   * What came out of the same spike was a message that mirrored the committed
   * document — headings, tables, four and a half thousand characters of a file
   * it had already linked. The one thing the document did not say, a bug found
   * and left unfixed, was buried in the middle of it.
   */
  test("asks for a closing message that points at the write-up instead of repeating it", () => {
    expect(text).toContain(
      "the shortest thing that lets a person decide what to do next"
    );
    expect(text).toContain("A link to where the detail lives");
    expect(text).toContain(
      "Whatever the thing you linked already says, do not say again here"
    );
    // The caveat is the part a summary would lose, and the part that decides
    // whether the reader follows the link at all.
    expect(text).toContain("a bug you found and did not fix");
    expect(text).toContain("no headings and no tables");
  });

  /**
   * The length is the editable half of the message rule and arrives from the
   * workspace document, so this run — which has no tree to read it from — has to
   * be handed the same words in its prompt.
   */
  test("states the length as a target, because a run with no write-up carries more", () => {
    expect(text).toContain("A few short paragraphs");
    expect(text).toContain(
      "a target and not a cap: a run with nothing to link has to carry its whole result in the message"
    );
  });

  test("tells a worker that loses the board where to leave its message instead", () => {
    // The name has to be the one `readHandoff` in `@workspace/orchestrator`
    // looks for. A worker told to write some other file writes a file nobody
    // collects, which is the bug this replaced.
    expect(text).toContain(HANDOFF_FILENAME);
    expect(text).toContain("If the board tools stop answering");
    // And it has to know the file is collected, or it spends its last turn
    // telling a person to go and fetch it.
    expect(text).toContain("read off the disk and posted for you");
  });

  test("says a run with no repo has a scratch directory, and no project has none", () => {
    const scratch = textOf({
      placement: barePlacement,
      project: null,
      repoUrl: null,
    });
    // Inside its task directory, and released with the run: the durable line
    // is about the level above, and this one may not claim it.
    expect(scratch).toContain(
      "- `/workspace/worker/delete-endpoint/scratch` is an empty scratch directory, yours to write, released when this run ends. This run has no repo."
    );
    expect(scratch).toContain(
      "- `/workspace/worker/delete-endpoint` is this task's directory"
    );
    expect(scratch).not.toContain("pull request");
    expect(scratch).not.toContain("## Project");
    // And no credential section: nothing to push, and a token it will not reach
    // for is one more paragraph between the run and its task.
    expect(scratch).not.toContain("The GitHub credential you hold");
  });

  test("passes on what was said before the first run ever started", () => {
    const text_ = textOf({
      messages: [messageOf({ body: "also delete the audit rows" })],
    });
    expect(text_).toContain("## The conversation on this task so far");
    expect(text_).toContain("the human said:");
    expect(text_).toContain("also delete the audit rows");
  });

  test("leaves out the conversation heading on a silent task, and measures itself", () => {
    expect(text).not.toContain("conversation on this task so far");
    expect(built.chars).toBe(text.length);
  });
});

/**
 * The prompt carries the seeded rules exactly when the filesystem cannot. A run
 * whose directories nest reads the same text out of the workspace document above
 * its working directory, and stating it twice is two copies to keep in step; a
 * local run is a host process with nothing above its working directory, so
 * dropping it there would lose it silently.
 */
describe("the seeded rules, on disk or in the prompt", () => {
  test("states the workspace document when the run has no tree to read it from", () => {
    expect(textOf({ instructionsOnDisk: false })).toContain(WORKSPACE_RULES);
    // A caller that has not been updated is that case, so silence means stated.
    expect(textOf({})).toContain(WORKSPACE_RULES);
  });

  test("hands over the same constant the seeder writes, not a second copy of it", () => {
    const text = textOf({});
    expect(text).toContain(WRITING_RULES);
    expect(text).toContain(MESSAGE_SHAPE_RULES);
  });

  test("leaves them out when the directories carry them", () => {
    const text = textOf({ instructionsOnDisk: true });
    expect(text).not.toContain(WORKSPACE_RULES);
    expect(text).not.toContain("## How you write");
    expect(text).not.toContain("A few short paragraphs");
    // Only that block. Everything a file on disk cannot say still has to be here,
    // including the rule the stop hook enforces.
    expect(text).toContain(SHARED_RULES);
    expect(text).toContain(CREDENTIAL_RULES);
    expect(text).toContain("post a message on this task");
    expect(text).toContain(
      artifactRulesOf({ hasProject: true, hasRepo: true })
    );
  });
});

describe("a resumed session's prompt", () => {
  const messages = [
    messageOf({ body: "the delete is not idempotent" }),
    messageOf({
      agentSessionId: sessionId,
      authorKind: "agent",
      authorUserId: null,
      body: "opened the PR",
      kind: "fallback",
    }),
    messageOf({
      agentSessionId: otherSessionId,
      authorKind: "agent",
      authorUserId: null,
      body: "the handler swallows the 404",
    }),
  ];
  const text = textOf({ messages, mode: "resumed" });

  test("carries every message since the watermark, labelled with its author", () => {
    expect(text).toContain("the human said:\nthe delete is not idempotent");
    expect(text).toContain("you said (auto-appended final message):");
    expect(text).toContain(
      `another session on this task (${otherSessionId.slice(0, 8)}) said:`
    );
    expect(text).toContain("the handler swallows the 404");
  });

  test("repeats nothing the session already has in its own history", () => {
    expect(text).not.toContain(task.brief);
    expect(text).not.toContain("the endpoint returns 204");
    expect(text).not.toContain(placement.artifactsDir);
    expect(text).not.toContain("## Project");
  });

  test("still states the rule the stop hook enforces per turn", () => {
    expect(text).toContain("post a message on this task");
    // Including how long it should be. Every turn of a resumed session ends
    // with a message too, and this is the only place that rule is stated.
    expect(text).toContain(
      "the shortest thing that lets a person decide what to do next"
    );
  });

  test("says so plainly when a rerun added nothing", () => {
    const silent = textOf({ mode: "resumed" });
    expect(silent).toContain("Nothing was added. Pick up where you stopped.");
  });
});

describe("message labels", () => {
  const label = (message: TaskMessage) =>
    messageLabelOf({ message, readerSessionId: sessionId });

  const crash = messageOf({
    authorKind: "orchestrator",
    authorUserId: null,
    body: "x",
  });

  test("names each kind of author, and flags a crash as the epitaph it is", () => {
    expect(label(messageOf({ body: "x" }))).toBe("the human said:");
    expect(label(messageOf({ authorKind: "manager", body: "x" }))).toBe(
      "the manager agent said:"
    );
    expect(label(crash)).toBe("the orchestrator said:");
    expect(label({ ...crash, kind: "run_error" })).toBe(
      "the orchestrator said (that run crashed):"
    );
  });

  test("tells the reader's own voice from another session's", () => {
    const mine = messageOf({
      agentSessionId: sessionId,
      authorKind: "agent",
      authorUserId: null,
      body: "x",
    });
    expect(label(mine)).toBe("you said:");
    expect(label({ ...mine, agentSessionId: otherSessionId })).toBe(
      `another session on this task (${otherSessionId.slice(0, 8)}) said:`
    );
  });
});
