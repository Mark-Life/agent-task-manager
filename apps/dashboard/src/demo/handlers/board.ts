/**
 * The board: tasks, projects and task messages, against the in-memory store.
 */

import { Api, type Task } from "@workspace/api";
import {
  newProjectEnvFileId,
  newProjectId,
  newTaskId,
  newTaskMessageId,
  rankBetween,
  type TaskStatus,
} from "@workspace/domain";
import { DateTime, Effect, Queue, Stream } from "effect";
import { HttpApiBuilder } from "effect/unstable/httpapi";
import { USAGE } from "@/demo/fixtures/workspace";
import { DEMO_USER, DEMO_WORKSPACE, now } from "@/demo/ids";
import {
  changed,
  db,
  find,
  liveRunOf,
  onChange,
  readBoard,
  update,
} from "@/demo/store";

/** Rank for a card placed right after `after` in `status`, or at the top. */
const rankAfter = (status: TaskStatus, after: number | null | undefined) => {
  const column = db.tasks
    .filter((task) => task.status === status)
    .map((task) => task.rank)
    .sort((a, b) => a - b);
  if (after === null || after === undefined) {
    return rankBetween(null, column[0] ?? null);
  }
  const below = column.find((rank) => rank > after) ?? null;
  return rankBetween(after, below);
};

const touch = (task: Task, fields: Partial<Task>) => {
  const next = update(db.tasks, { ...task, ...fields, updatedAt: now() });
  changed();
  return next;
};

/** Every push of the board: the board now, then again on each change. */
const boardPushes = (projectId: Parameters<typeof readBoard>[0]) =>
  Stream.callback<ReturnType<typeof readBoard>>((queue) =>
    Effect.acquireRelease(
      Effect.sync(() => {
        const push = () => Queue.offerUnsafe(queue, readBoard(projectId));
        push();
        return onChange(push);
      }),
      (off) => Effect.sync(off)
    )
  );

export const tasksHandlers = HttpApiBuilder.group(Api, "tasks", (handlers) =>
  handlers
    .handle("list", ({ query }) =>
      Effect.sync(() =>
        db.tasks.filter(
          (task) =>
            (query.status === undefined || task.status === query.status) &&
            (query.projectId === undefined ||
              task.projectId === query.projectId)
        )
      )
    )
    .handle("board", ({ query }) =>
      Effect.sync(() => readBoard(query.projectId))
    )
    .handle("boardStream", ({ query }) =>
      Effect.succeed(boardPushes(query.projectId))
    )
    .handle("get", ({ params }) =>
      Effect.map(find(db.tasks, "task", params.taskId), (task) => ({
        liveRunId: liveRunOf(task.id),
        project: db.projects.find((p) => p.id === task.projectId) ?? null,
        task,
      }))
    )
    .handle("create", ({ payload }) =>
      Effect.sync(() => {
        const status = payload.status ?? "ideas";
        const at = now();
        const task: Task = {
          acceptance: payload.acceptance ?? null,
          brief: payload.brief ?? "",
          createdAt: at,
          dispatchTraceparent: null,
          id: newTaskId(),
          metadata: payload.metadata ?? {},
          nextSessionId: null,
          nextSessionNew: false,
          parentTaskId: payload.parentTaskId ?? null,
          parkedUntil: null,
          projectId: payload.projectId ?? null,
          prState: null,
          prStateAt: null,
          prUrl: payload.prUrl ?? null,
          rank: rankAfter(status, null),
          repoUrl: payload.repoUrl ?? null,
          sandboxImage: payload.sandboxImage ?? null,
          status,
          statusChangedAt: at,
          title: payload.title,
          updatedAt: at,
          workspaceId: DEMO_WORKSPACE,
        };
        db.tasks.push(task);
        changed();
        return task;
      })
    )
    .handle("patch", ({ params, payload }) =>
      Effect.map(find(db.tasks, "task", params.taskId), (task) =>
        touch(task, payload)
      )
    )
    .handle("transition", ({ params, payload }) =>
      Effect.map(find(db.tasks, "task", params.taskId), (task) =>
        touch(task, {
          rank: rankAfter(payload.to, payload.after),
          status: payload.to,
          statusChangedAt: now(),
        })
      )
    )
    .handle("place", ({ params, payload }) =>
      Effect.map(find(db.tasks, "task", params.taskId), (task) =>
        touch(task, { rank: rankAfter(task.status, payload.after) })
      )
    )
    .handle("selectNextSession", ({ params, payload }) =>
      Effect.map(find(db.tasks, "task", params.taskId), (task) =>
        touch(task, {
          nextSessionId: payload.mode === "specific" ? payload.sessionId : null,
          nextSessionNew: payload.mode === "new",
        })
      )
    )
    .handle("delete", ({ params }) =>
      Effect.map(find(db.tasks, "task", params.taskId), (task) => {
        db.tasks = db.tasks.filter((other) => other.id !== task.id);
        changed();
      })
    )
);

export const projectsHandlers = HttpApiBuilder.group(
  Api,
  "projects",
  (handlers) =>
    handlers
      .handle("list", () => Effect.sync(() => db.projects))
      .handle("get", ({ params }) =>
        find(db.projects, "project", params.projectId)
      )
      .handle("create", ({ payload }) =>
        Effect.sync(() => {
          const at = now();
          const project = {
            createdAt: at,
            description: payload.description ?? null,
            id: newProjectId(),
            name: payload.name,
            repoDefaultBranch: payload.repoDefaultBranch ?? null,
            repoUrl: payload.repoUrl ?? null,
            updatedAt: at,
            workspaceId: DEMO_WORKSPACE,
          };
          db.projects.push(project);
          return project;
        })
      )
      .handle("patch", ({ params, payload }) =>
        Effect.map(find(db.projects, "project", params.projectId), (project) =>
          update(db.projects, { ...project, ...payload, updatedAt: now() })
        )
      )
      .handle("delete", ({ params }) =>
        Effect.map(
          find(db.projects, "project", params.projectId),
          (project) => {
            db.projects = db.projects.filter(
              (other) => other.id !== project.id
            );
          }
        )
      )
      .handle("listEnv", ({ params }) =>
        Effect.sync(() =>
          db.envFiles
            .filter((file) => file.projectId === params.projectId)
            .map(({ content: _content, ...file }) => file)
        )
      )
      .handle("getEnv", ({ params }) =>
        find(db.envFiles, "env file", params.fileId)
      )
      .handle("saveEnv", ({ params, payload }) =>
        Effect.sync(() => {
          const at = now();
          const existing = db.envFiles.find(
            (other) =>
              other.projectId === params.projectId &&
              other.path === payload.path
          );
          const file = {
            createdAt: existing?.createdAt ?? at,
            id: existing?.id ?? newProjectEnvFileId(),
            path: payload.path,
            projectId: params.projectId,
            updatedAt: at,
            workspaceId: DEMO_WORKSPACE,
          };
          db.envFiles = [
            ...db.envFiles.filter((other) => other.id !== file.id),
            { ...file, content: payload.content },
          ];
          return file;
        })
      )
      .handle("deleteEnv", ({ params }) =>
        Effect.sync(() => {
          db.envFiles = db.envFiles.filter((file) => file.id !== params.fileId);
        })
      )
);

export const messagesHandlers = HttpApiBuilder.group(
  Api,
  "messages",
  (handlers) =>
    handlers
      .handle("list", ({ params }) =>
        Effect.sync(() =>
          db.messages.filter((message) => message.taskId === params.taskId)
        )
      )
      .handle("post", ({ params, payload }) =>
        Effect.sync(() => {
          const at = now();
          const message = {
            agentSessionId: null,
            authorKind: "human" as const,
            authorUserId: DEMO_USER,
            body: payload.body,
            createdAt: at,
            id: newTaskMessageId(),
            kind: payload.kind ?? "message",
            runId: null,
            taskId: params.taskId,
            updatedAt: at,
            workspaceId: DEMO_WORKSPACE,
          };
          db.messages.push(message);
          return message;
        })
      )
);

export const healthHandlers = HttpApiBuilder.group(Api, "health", (handlers) =>
  handlers.handle("check", () =>
    Effect.sync(() => ({
      status: "ok" as const,
      timestamp: DateTime.formatIso(now()),
    }))
  )
);

export const usageHandlers = HttpApiBuilder.group(Api, "usage", (handlers) =>
  handlers.handle("get", () => Effect.succeed(USAGE))
);
