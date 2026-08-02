/**
 * Two halves, tested two ways.
 *
 * The assembly is pure, so every shape it can produce — the fresh briefing, the
 * resumed delta, the labels that tell one session's voice from another's — is
 * checked against rows built in this file with no database in sight.
 *
 * The watermark walk is not pure and cannot honestly be faked: the comparison
 * that decides which comments a session has already read is a row-wise
 * `(created_at, id)` tuple evaluated by Postgres, so a fake would only prove the
 * fake orders things the way this file does. It runs against the real database,
 * against the workspace the seed created, and deletes the task it made — which
 * cascades its session and its comments. The audit rows stay, as they do for
 * every mutation in this system.
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import {
  AgentSessionRepo,
  CommentRepo,
  storeLayer,
  TaskRepo,
  WorkspaceRepo,
  withActor,
} from "@workspace/db";
import {
  type Actor,
  type AgentSession,
  type Comment,
  newAgentSessionId,
  newCommentId,
  newProjectId,
  newRunId,
  newTaskId,
  type Project,
  type Task,
  UserId,
  WorkspaceId,
} from "@workspace/domain";
import { hostRunLayout } from "@workspace/harness";
import type { RunWorkspace } from "@workspace/sandbox";
import { DateTime, Effect, Schema } from "effect";
import type { DispatchContext, ResolvedSession } from "./dispatch-context";
import {
  buildPrompt,
  buildRunPrompt,
  commentLabelOf,
  nextWatermarkOf,
  placementOf,
  type RunPlacement,
  unreadOf,
  watermarkOf,
} from "./prompt";

const at = DateTime.makeUnsafe("2026-08-02T10:00:00.000Z");
const later = DateTime.makeUnsafe("2026-08-02T11:00:00.000Z");
const workspaceId = WorkspaceId.make("ws-1");
const userId = UserId.make("user-1");
const taskId = newTaskId();
const runId = newRunId();
const sessionId = newAgentSessionId();
const otherSessionId = newAgentSessionId();

const task: Task = {
  acceptance: "the endpoint returns 204 and the row is gone",
  brief: "delete the thing when the user asks for it",
  createdAt: at,
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

const session: AgentSession = {
  commentWatermarkAt: null,
  commentWatermarkId: null,
  createdAt: at,
  endedAt: null,
  errorMessage: null,
  id: sessionId,
  provider: "claude",
  providerSessionId: "provider-sess-1",
  status: "finished",
  taskId,
  updatedAt: at,
  workspaceId,
};

const fresh: ResolvedSession = { mode: "fresh", selected: "new", session };
const resumed: ResolvedSession = {
  mode: "resumed",
  providerSessionId: "provider-sess-1",
  selected: "latest",
  session,
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

const textOf = (input: {
  readonly comments?: readonly Comment[];
  readonly project?: Project | null;
  readonly repoUrl?: string | null;
  readonly session?: ResolvedSession;
}) =>
  buildPrompt({
    comments: input.comments ?? [],
    placement,
    project: input.project === undefined ? project : input.project,
    repoUrl: input.repoUrl === undefined ? task.repoUrl : input.repoUrl,
    session: input.session ?? fresh,
    task,
  }).text;

describe("a fresh session's prompt", () => {
  const built = buildPrompt({
    comments: [],
    placement,
    project,
    repoUrl: task.repoUrl,
    session: fresh,
    task,
  });
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

  test("gives the artifacts rule as one line and names the read-only folders", () => {
    expect(text).toContain(
      "- Anything worth keeping goes in `/artifacts/task`; everything else is scratch and dies with the container."
    );
    expect(text).toContain(
      "- Read-only reference material: `/artifacts/project` (this project) and `/artifacts/global`."
    );
  });

  test("teaches the rule the stop hook enforces", () => {
    expect(text).toContain("post a comment on this task");
    expect(text).toContain("sent back to write it");
  });

  test("says a task with no repo has a scratch directory, and no project has none", () => {
    const scratch = textOf({ project: null, repoUrl: null });
    expect(scratch).toContain("`/workspace` is an empty scratch directory");
    expect(scratch).not.toContain("pull request");
    expect(scratch).not.toContain("## Project");
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
  const text = textOf({ comments, session: resumed });

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
    const silent = textOf({ session: resumed });
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

describe("placement", () => {
  const runWorkspace: RunWorkspace = {
    branch: "atm/task-1",
    globalArtifactsDir: "/host/.data/artifacts/global",
    projectArtifactsDir: "/host/.data/artifacts/projects/p1",
    runDir: "/host/.data/runs/r1",
    strategy: "mount",
    taskArtifactsDir: "/host/.data/artifacts/tasks/t1",
    workspaceDir: "/host/.data/workspaces/r1",
  };

  test("names the mount points a container sees", () => {
    expect(placementOf({ kind: "docker", workspace: runWorkspace })).toEqual({
      artifactsDir: "/artifacts/task",
      branch: "atm/task-1",
      globalArtifactsDir: "/artifacts/global",
      projectArtifactsDir: "/artifacts/project",
      workspaceDir: "/workspace",
    });
  });

  test("names the host paths a local run actually has", () => {
    expect(placementOf({ kind: "local", workspace: runWorkspace })).toEqual({
      artifactsDir: "/host/.data/artifacts/tasks/t1",
      branch: "atm/task-1",
      globalArtifactsDir: "/host/.data/artifacts/global",
      projectArtifactsDir: "/host/.data/artifacts/projects/p1",
      workspaceDir: "/host/.data/workspaces/r1",
    });
  });

  test("mentions no project folder where none is mounted", () => {
    expect(
      placementOf({
        kind: "docker",
        workspace: { ...runWorkspace, projectArtifactsDir: null },
      }).projectArtifactsDir
    ).toBeNull();
  });
});

describe("the watermark", () => {
  test("is both halves or neither", () => {
    expect(watermarkOf(session)).toBeNull();
    expect(
      watermarkOf({
        commentWatermarkAt: at,
        commentWatermarkId: null,
      })
    ).toBeNull();
    const id = newCommentId();
    expect(
      watermarkOf({ commentWatermarkAt: at, commentWatermarkId: id })
    ).toEqual({ createdAt: at, id });
  });

  test("advances to the last comment rendered, not the newest timestamp", () => {
    const first = commentOf({ body: "one" });
    const second = commentOf({ body: "two", createdAt: later });
    expect(nextWatermarkOf([first, second])).toEqual({
      createdAt: later,
      id: second.id,
    });
  });

  /**
   * The tie is the reason the watermark is a tuple. Two comments written in the
   * same millisecond order by id, so the position after reading both is the
   * second one's id — taking the maximum timestamp would pick one of the pair
   * and leave the other unreachable, since `(createdAt, id) > watermark` is
   * false for a row that shares the timestamp and sorts lower.
   */
  test("carries the id through a same-millisecond tie", () => {
    const first = commentOf({ body: "one" });
    const second = commentOf({ body: "two" });
    expect(first.createdAt).toEqual(second.createdAt);
    expect(nextWatermarkOf([first, second])).toEqual({
      createdAt: at,
      id: second.id,
    });
  });

  test("does not move on a thread with nothing in it", () => {
    expect(nextWatermarkOf([])).toBeNull();
  });
});

describe("what a session has genuinely not read", () => {
  const first = commentOf({ body: "one" });
  const second = commentOf({ body: "two" });
  const third = commentOf({ body: "three", createdAt: later });

  /**
   * The column keeps microseconds and a `Timestamp` keeps milliseconds, so the
   * watermark is a truncated copy of the comment it names and Postgres hands
   * that comment straight back. Dropping it here is what stops a resumed run
   * from re-reading the last thing it was shown — its own fallback comment,
   * usually.
   */
  test("drops the comment the watermark itself names", () => {
    expect(
      unreadOf({
        comments: [second, third],
        watermark: { createdAt: second.createdAt, id: second.id },
      })
    ).toEqual([third]);
  });

  test("keeps a same-millisecond sibling the watermark does not cover", () => {
    expect(first.createdAt).toEqual(second.createdAt);
    expect(
      unreadOf({
        comments: [first, second],
        watermark: { createdAt: first.createdAt, id: first.id },
      })
    ).toEqual([second]);
    expect(unreadOf({ comments: [first], watermark: null })).toHaveLength(1);
  });
});

/** What the walk below leaves behind, so `afterAll` can erase it. */
const created: { taskId: Task["id"] | null } = { taskId: null };

const APPLICATION_NAME = "orchestrator-prompt-test";
const store = storeLayer({ applicationName: APPLICATION_NAME });
const actor: Actor = {
  kind: "orchestrator",
  loopInstance: APPLICATION_NAME,
  runId,
};

/** This database has never been seeded, so there is no workspace to hang rows off. */
class NoWorkspace extends Schema.TaggedErrorClass<NoWorkspace>()(
  "PromptTest.NoWorkspace",
  {}
) {}

const walk = Effect.gen(function* () {
  const workspaces = yield* WorkspaceRepo;
  const tasks = yield* TaskRepo;
  const comments = yield* CommentRepo;
  const sessions = yield* AgentSessionRepo;

  const [workspace] = yield* workspaces.list();
  if (workspace === undefined) {
    return yield* Effect.fail(new NoWorkspace());
  }
  const scope = workspace.id;

  const filed = yield* tasks.create({
    acceptance: "the watermark moves",
    brief: "prove the prompt reads each comment exactly once",
    title: "prompt watermark walk",
    workspaceId: scope,
  });
  created.taskId = filed.id;

  const opened = yield* sessions.open({
    provider: "claude",
    taskId: filed.id,
    workspaceId: scope,
  });

  yield* comments.append({
    author: { kind: "human", userId: UserId.make("prompt-test-human") },
    body: "start with the delete path",
    taskId: filed.id,
    workspaceId: scope,
  });
  const second = yield* comments.append({
    author: { kind: "agent", runId: null, sessionId: opened.id },
    body: "opened the PR",
    kind: "fallback",
    taskId: filed.id,
    workspaceId: scope,
  });

  const contextOf = (current: AgentSession, mode: "fresh" | "resumed") =>
    ({
      actor,
      attempt: 1,
      image: "atm.local/base:latest",
      layout: hostRunLayout({ dataRoot: ".data", runId }),
      project: null,
      provider: "claude",
      queueWaitMs: 0,
      repoUrl: null,
      runId,
      session:
        mode === "fresh"
          ? { mode, selected: "new", session: current }
          : {
              mode,
              providerSessionId: "provider-sess-1",
              selected: "latest",
              session: current,
            },
      spanId: null,
      task: { ...filed, id: filed.id },
      traceId: null,
      traceparent: null,
      trigger: "status_change",
    }) satisfies DispatchContext;

  /** The session row as it stands now, which is where the watermark shows up. */
  const reread = () => sessions.byId({ id: opened.id, workspaceId: scope });

  const firstPrompt = yield* buildRunPrompt({
    context: contextOf(opened, "fresh"),
    placement,
  });
  const afterFirst = yield* reread();

  const secondPrompt = yield* buildRunPrompt({
    context: contextOf(afterFirst, "resumed"),
    placement,
  });
  const afterSecond = yield* reread();

  const third = yield* comments.append({
    author: { kind: "human", userId: UserId.make("prompt-test-human") },
    body: "the review found a missing 404",
    taskId: filed.id,
    workspaceId: scope,
  });

  const thirdPrompt = yield* buildRunPrompt({
    context: contextOf(afterSecond, "resumed"),
    placement,
  });
  const afterThird = yield* reread();

  return {
    afterFirst,
    afterSecond,
    afterThird,
    firstPrompt,
    ids: { second: second.id, third: third.id },
    secondPrompt,
    thirdPrompt,
  };
}).pipe(withActor(actor), Effect.provide(store));

/** The whole walk, run once: a pool per test would out-connect Postgres. */
let walked: Effect.Success<typeof walk>;

beforeAll(async () => {
  walked = await Effect.runPromise(walk);
});

afterAll(async () => {
  const id = created.taskId;
  if (id === null) {
    return;
  }
  await Effect.runPromise(
    Effect.gen(function* () {
      const tasks = yield* TaskRepo;
      const [workspace] = yield* (yield* WorkspaceRepo).list();
      if (workspace !== undefined) {
        yield* tasks.delete({ id, workspaceId: workspace.id });
      }
    }).pipe(withActor(actor), Effect.provide(store))
  );
});

describe("the watermark walk, against Postgres", () => {
  test("gives a first run everything already said on the task", () => {
    expect(walked.firstPrompt.text).toContain("start with the delete path");
    expect(walked.firstPrompt.text).toContain("opened the PR");
  });

  test("moves the watermark to the last comment it handed over", () => {
    expect(walked.afterFirst.commentWatermarkId).toBe(walked.ids.second);
    expect(walked.afterFirst.commentWatermarkAt).not.toBeNull();
  });

  test("hands a resumed run nothing when nothing was added", () => {
    expect(walked.secondPrompt.text).toContain("Nothing was added");
    expect(walked.secondPrompt.text).not.toContain(
      "start with the delete path"
    );
  });

  test("does not read the session's own fallback comment back as input", () => {
    expect(walked.secondPrompt.text).not.toContain("opened the PR");
  });

  test("hands over exactly the comment added since, labelled", () => {
    expect(walked.thirdPrompt.text).toContain(
      "the human said:\nthe review found a missing 404"
    );
    expect(walked.thirdPrompt.text).not.toContain("start with the delete path");
    expect(walked.afterThird.commentWatermarkId).toBe(walked.ids.third);
  });

  test("leaves the watermark alone when there was nothing to advance past", () => {
    expect(walked.afterSecond.commentWatermarkId).toBe(walked.ids.second);
  });
});
