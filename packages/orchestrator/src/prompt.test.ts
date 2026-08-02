/**
 * The half that cannot be pure.
 *
 * The prompt text is asserted in `@workspace/prompts`, against rows built in a
 * file with no database in sight. What is left here is the walk that proves the
 * watermark: the comparison deciding which comments a session has already read
 * is a row-wise `(created_at, id)` tuple evaluated by Postgres, so a fake would
 * only prove that the fake orders things the way the test does. It runs against
 * the real database, against the workspace the seed created, and deletes the
 * task it made — which cascades its session and its comments. The audit rows
 * stay, as they do for every mutation in this system.
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
  newCommentId,
  newRunId,
  type Task,
  UnreadWatermarkId,
  UserId,
} from "@workspace/domain";
import { hostRunLayout } from "@workspace/harness";
import type { RunPlacement } from "@workspace/prompts";
import type { RunWorkspace } from "@workspace/sandbox";
import { DateTime, Effect, Schema } from "effect";
import type { DispatchContext } from "./dispatch-context";
import { buildRunPrompt, placementOf, watermarkOf } from "./prompt";
import { workerAttachment } from "./subject";

const at = DateTime.makeUnsafe("2026-08-02T10:00:00.000Z");
const runId = newRunId();

const placement: RunPlacement = {
  artifactsDir: "/artifacts/task",
  branch: "atm/task-1",
  globalArtifactsDir: "/artifacts/global",
  projectArtifactsDir: "/artifacts/project",
  workspaceDir: "/workspace",
};

describe("the session's read position", () => {
  test("is both halves or neither", () => {
    expect(
      watermarkOf({ unreadWatermarkAt: null, unreadWatermarkId: null })
    ).toBeNull();
    expect(
      watermarkOf({ unreadWatermarkAt: at, unreadWatermarkId: null })
    ).toBeNull();
    const id = UnreadWatermarkId.make(newCommentId());
    expect(
      watermarkOf({ unreadWatermarkAt: at, unreadWatermarkId: id })
    ).toEqual({ createdAt: at, id });
  });
});

describe("placement", () => {
  const runWorkspace: RunWorkspace = {
    agentHomeDir: "/host/.claude-task-management",
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
    subject: { id: filed.id, kind: "task" },
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
      attached: workerAttachment(filed),
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

/**
 * The watermark column carries no table's brand — it points at a comment on a
 * task's session and at a chat message on a thread's — so a comparison against
 * either spells both sides as text.
 */
const idText = (id: string | null) => id;

describe("the watermark walk, against Postgres", () => {
  test("gives a first run everything already said on the task", () => {
    expect(walked.firstPrompt.text).toContain("start with the delete path");
    expect(walked.firstPrompt.text).toContain("opened the PR");
  });

  test("moves the watermark to the last comment it handed over", () => {
    expect(idText(walked.afterFirst.unreadWatermarkId)).toBe(
      idText(walked.ids.second)
    );
    expect(walked.afterFirst.unreadWatermarkAt).not.toBeNull();
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
    expect(idText(walked.afterThird.unreadWatermarkId)).toBe(
      idText(walked.ids.third)
    );
  });

  test("leaves the watermark alone when there was nothing to advance past", () => {
    expect(idText(walked.afterSecond.unreadWatermarkId)).toBe(
      idText(walked.ids.second)
    );
  });
});
