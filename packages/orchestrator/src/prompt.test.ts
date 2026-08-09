/**
 * The half that cannot be pure.
 *
 * The prompt text is asserted in `@workspace/prompts`, against rows built in a
 * file with no database in sight. What is left here is the walk that proves the
 * watermark: the comparison deciding which messages a session has already read
 * is a row-wise `(created_at, id)` tuple evaluated by Postgres, so a fake would
 * only prove that the fake orders things the way the test does. It runs against
 * the real database, against the workspace the seed created, and deletes the
 * task it made — which cascades its session and its messages. The audit rows
 * stay, as they do for every mutation in this system.
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import {
  AgentSessionRepo,
  storeLayer,
  TaskMessageRepo,
  TaskRepo,
  WorkspaceRepo,
  withActor,
} from "@workspace/db";
import {
  type Actor,
  type AgentSession,
  newRunId,
  newTaskMessageId,
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
  artifactsDir: "/workspace/worker/atlas/ship-the-thing",
  branch: "atm/task-1",
  globalArtifactsDir: "/workspace",
  projectArtifactsDir: "/workspace/worker/atlas",
  workspaceDir: "/workspace/worker/atlas/ship-the-thing/mark-life-atlas",
};

describe("the session's read position", () => {
  test("is both halves or neither", () => {
    expect(
      watermarkOf({ unreadWatermarkAt: null, unreadWatermarkId: null })
    ).toBeNull();
    expect(
      watermarkOf({ unreadWatermarkAt: at, unreadWatermarkId: null })
    ).toBeNull();
    const id = UnreadWatermarkId.make(newTaskMessageId());
    expect(
      watermarkOf({ unreadWatermarkAt: at, unreadWatermarkId: id })
    ).toEqual({ createdAt: at, id });
  });
});

/**
 * What the prompt says about where the run is, against what the mount set
 * actually binds.
 *
 * The paths a container sees are per-run now — they are spelled with the
 * project's name and the task's title — so a prompt that named a constant would
 * send the agent to a directory belonging to nobody. Both halves are built from
 * the same labels, and these are the cases where the two could drift: a run with
 * no repository, a task with no project, and a project folder the mount set
 * omitted.
 */
describe("placement", () => {
  const runWorkspace: RunWorkspace = {
    agentHomeDir: "/host/.claude-task-management",
    branch: "atm/task-1",
    cacheDir: "/host/.data/caches",
    composedSkillsDir: null,
    envFiles: { excluded: false, paths: [] },
    globalArtifactsDir: "/host/.data/artifacts/global",
    labels: {
      project: "Atlas",
      repo: "mark-life/atlas",
      task: "Ship the thing",
    },
    projectArtifactsDir: "/host/.data/artifacts/projects/p1",
    runDir: "/host/.data/runs/r1",
    strategy: "mount",
    taskArtifactsDir: "/host/.data/artifacts/tasks/t1",
    workspaceDir: "/host/.data/workspaces/r1",
  };

  test("names the scopes of the tree a container works in", () => {
    expect(placementOf({ kind: "docker", workspace: runWorkspace })).toEqual({
      artifactsDir: "/workspace/worker/atlas/ship-the-thing",
      branch: "atm/task-1",
      globalArtifactsDir: "/workspace",
      projectArtifactsDir: "/workspace/worker/atlas",
      workspaceDir: "/workspace/worker/atlas/ship-the-thing/mark-life-atlas",
    });
  });

  test("says a run with no repo works in its scratch directory", () => {
    expect(
      placementOf({
        kind: "docker",
        workspace: {
          ...runWorkspace,
          labels: { ...runWorkspace.labels, repo: null },
        },
      }).workspaceDir
    ).toBe("/workspace/worker/atlas/ship-the-thing/scratch");
  });

  test("skips the project level for a task that has no project", () => {
    const placed = placementOf({
      kind: "docker",
      workspace: {
        ...runWorkspace,
        labels: { ...runWorkspace.labels, project: null },
        projectArtifactsDir: null,
      },
    });
    expect(placed.artifactsDir).toBe("/workspace/worker/ship-the-thing");
    expect(placed.projectArtifactsDir).toBeNull();
  });

  test("mentions no project folder where none is mounted", () => {
    expect(
      placementOf({
        kind: "docker",
        workspace: { ...runWorkspace, projectArtifactsDir: null },
      }).projectArtifactsDir
    ).toBeNull();
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

/**
 * Who tears the fixture down. Erasing a task is owner-only, so the teardown
 * asks as a person rather than as the loop that made it.
 */
const remover: Actor = {
  kind: "human",
  userId: UserId.make(APPLICATION_NAME),
};

/** This database has never been seeded, so there is no workspace to hang rows off. */
class NoWorkspace extends Schema.TaggedErrorClass<NoWorkspace>()(
  "PromptTest.NoWorkspace",
  {}
) {}

const walk = Effect.gen(function* () {
  const workspaces = yield* WorkspaceRepo;
  const tasks = yield* TaskRepo;
  const messages = yield* TaskMessageRepo;
  const sessions = yield* AgentSessionRepo;

  const [workspace] = yield* workspaces.list();
  if (workspace === undefined) {
    return yield* Effect.fail(new NoWorkspace());
  }
  const scope = workspace.id;

  const filed = yield* tasks.create({
    acceptance: "the watermark moves",
    brief: "prove the prompt reads each message exactly once",
    title: "prompt watermark walk",
    workspaceId: scope,
  });
  created.taskId = filed.id;

  const opened = yield* sessions.open({
    provider: "claude",
    subject: { id: filed.id, kind: "task" },
    workspaceId: scope,
  });

  yield* messages.post({
    author: { kind: "human", userId: UserId.make("prompt-test-human") },
    body: "start with the delete path",
    taskId: filed.id,
    workspaceId: scope,
  });
  const second = yield* messages.post({
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
    sandboxKind: "docker",
  });
  const afterFirst = yield* reread();

  const secondPrompt = yield* buildRunPrompt({
    context: contextOf(afterFirst, "resumed"),
    placement,
    sandboxKind: "docker",
  });
  const afterSecond = yield* reread();

  const third = yield* messages.post({
    author: { kind: "human", userId: UserId.make("prompt-test-human") },
    body: "the review found a missing 404",
    taskId: filed.id,
    workspaceId: scope,
  });

  const thirdPrompt = yield* buildRunPrompt({
    context: contextOf(afterSecond, "resumed"),
    placement,
    sandboxKind: "docker",
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
        yield* tasks
          .delete({ id, workspaceId: workspace.id })
          .pipe(withActor(remover));
      }
    }).pipe(withActor(actor), Effect.provide(store))
  );
});

/**
 * The watermark column carries no table's brand — it points at a message on a
 * task's session and at a chat message on a thread's — so a comparison against
 * either spells both sides as text.
 */
const idText = (id: string | null) => id;

describe("the watermark walk, against Postgres", () => {
  test("gives a first run everything already said on the task", () => {
    expect(walked.firstPrompt.text).toContain("start with the delete path");
    expect(walked.firstPrompt.text).toContain("opened the PR");
  });

  test("moves the watermark to the last message it handed over", () => {
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

  test("does not read the session's own fallback message back as input", () => {
    expect(walked.secondPrompt.text).not.toContain("opened the PR");
  });

  test("hands over exactly the message added since, labelled", () => {
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
