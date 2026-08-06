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
  type Comment,
  HANDOFF_FILENAME,
  newAgentSessionId,
  newCommentId,
  newProjectId,
  newTaskId,
  type Project,
  type Task,
  UserId,
  WorkspaceId,
} from "@workspace/domain";
import { DateTime } from "effect";
import type { PromptMode, RunPlacement } from "./render";
import { ARTIFACT_RULES, CREDENTIAL_RULES, SHARED_RULES } from "./rules";
import { buildWorkerPrompt, commentLabelOf } from "./worker";

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

const placement: RunPlacement = {
  artifactsDir: "/artifacts/task",
  branch: "atm/task-1",
  globalArtifactsDir: "/artifacts/global",
  projectArtifactsDir: "/artifacts/project",
  workspaceDir: "/workspace",
};

/** A comment on the fixture task, with only the fields a prompt reads spelled out. */
const commentOf = (
  input: Partial<Comment> & Pick<Comment, "body">
): Comment => ({
  agentSessionId: null,
  authorKind: "human",
  authorUserId: userId,
  createdAt: at,
  id: newCommentId(),
  kind: "message",
  runId: null,
  taskId,
  updatedAt: at,
  workspaceId,
  ...input,
});

const promptOf = (input: {
  readonly comments?: readonly Comment[];
  readonly mode?: PromptMode;
  readonly project?: Project | null;
  readonly repoUrl?: string | null;
}) =>
  buildWorkerPrompt({
    comments: input.comments ?? [],
    mode: input.mode ?? "fresh",
    placement,
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

  test("names the writable folder and the read-only ones, and states the rule once", () => {
    expect(text).toContain(
      "- `/artifacts/task` is yours to write, and what you leave there outlives the container."
    );
    expect(text).toContain(
      "- Read-only reference material: `/artifacts/project` (this project) and `/artifacts/global`."
    );
    expect(text).toContain(ARTIFACT_RULES);
    expect(text).toContain(SHARED_RULES);
  });

  test("teaches the rule the stop hook enforces", () => {
    expect(text).toContain("post a comment on this task");
    expect(text).toContain("sent back to write it");
  });

  test("tells a worker that loses the board where to leave its comment instead", () => {
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
    const scratch = textOf({ project: null, repoUrl: null });
    expect(scratch).toContain("`/workspace` is an empty scratch directory");
    expect(scratch).not.toContain("pull request");
    expect(scratch).not.toContain("## Project");
    // And no credential section: nothing to push, and a token it will not reach
    // for is one more paragraph between the run and its task.
    expect(scratch).not.toContain("The GitHub credential you hold");
  });

  test("passes on what was said before the first run ever started", () => {
    const text_ = textOf({
      comments: [commentOf({ body: "also delete the audit rows" })],
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

describe("a resumed session's prompt", () => {
  const comments = [
    commentOf({ body: "the delete is not idempotent" }),
    commentOf({
      agentSessionId: sessionId,
      authorKind: "agent",
      authorUserId: null,
      body: "opened the PR",
      kind: "fallback",
    }),
    commentOf({
      agentSessionId: otherSessionId,
      authorKind: "agent",
      authorUserId: null,
      body: "the handler swallows the 404",
    }),
  ];
  const text = textOf({ comments, mode: "resumed" });

  test("carries every comment since the watermark, labelled with its author", () => {
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
    expect(text).not.toContain("/artifacts/task");
    expect(text).not.toContain("## Project");
  });

  test("still states the rule the stop hook enforces per turn", () => {
    expect(text).toContain("post a comment on this task");
  });

  test("says so plainly when a rerun added nothing", () => {
    const silent = textOf({ mode: "resumed" });
    expect(silent).toContain("Nothing was added. Pick up where you stopped.");
  });
});

describe("comment labels", () => {
  const label = (comment: Comment) =>
    commentLabelOf({ comment, readerSessionId: sessionId });

  const crash = commentOf({
    authorKind: "orchestrator",
    authorUserId: null,
    body: "x",
  });

  test("names each kind of author, and flags a crash as the epitaph it is", () => {
    expect(label(commentOf({ body: "x" }))).toBe("the human said:");
    expect(label(commentOf({ authorKind: "manager", body: "x" }))).toBe(
      "the manager agent said:"
    );
    expect(label(crash)).toBe("the orchestrator said:");
    expect(label({ ...crash, kind: "run_error" })).toBe(
      "the orchestrator said (that run crashed):"
    );
  });

  test("tells the reader's own voice from another session's", () => {
    const mine = commentOf({
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
