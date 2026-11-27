/**
 * The demo's whole database: plain arrays, seeded from the fixtures, changed in
 * place by the handlers. A reload starts over.
 */

import type {
  AgentSession,
  Artifact,
  BoardColumn,
  Project,
  ProjectEnvFile,
  Run,
  RunCommand,
  RunEvent,
  Task,
  TaskMessage,
  Thread,
  ThreadMessage,
} from "@workspace/api";
import { NotFound } from "@workspace/api";
import {
  isRunLive,
  type ProjectId,
  TASK_STATUSES,
  type TaskId,
} from "@workspace/domain";
import { DateTime, Effect } from "effect";
import { HUMAN_MESSAGES, THREAD_MESSAGES, THREADS } from "./fixtures/chat";
import { PROJECTS } from "./fixtures/projects";
import { RUN_MESSAGES, RUNS } from "./fixtures/runs";
import { TASKS } from "./fixtures/tasks";
import { ARTIFACTS, SCOPE_FILES } from "./fixtures/workspace";

export const millis = DateTime.toEpochMillis;

const byCreated = <A extends { readonly createdAt: DateTime.Utc }>(
  a: A,
  b: A
) => millis(a.createdAt) - millis(b.createdAt);

export const db = {
  artifacts: [...ARTIFACTS] as Artifact[],
  commands: [] as RunCommand[],
  envFiles: [] as (ProjectEnvFile & { content: string })[],
  events: RUNS.flatMap((demo) => demo.events) as RunEvent[],
  files: structuredClone(SCOPE_FILES),
  messages: [...RUN_MESSAGES, ...HUMAN_MESSAGES].sort(
    byCreated
  ) as TaskMessage[],
  projects: [...PROJECTS] as Project[],
  runs: RUNS.map((demo) => demo.run) as Run[],
  sessions: RUNS.map((demo) => demo.session) as AgentSession[],
  tasks: [...TASKS] as Task[],
  threadMessages: [...THREAD_MESSAGES] as ThreadMessage[],
  threads: [...THREADS] as Thread[],
};

const listeners = new Set<() => void>();

/** Tell every open board stream that a card moved. */
export const changed = () => {
  for (const listener of listeners) {
    listener();
  }
};

export const onChange = (listener: () => void) => {
  listeners.add(listener);
  return () => listeners.delete(listener);
};

export const liveRunOf = (taskId: TaskId) =>
  db.runs.find((run) => run.taskId === taskId && isRunLive(run))?.id ?? null;

export const readBoard = (projectId: ProjectId | undefined): BoardColumn[] =>
  TASK_STATUSES.map((status) => ({
    status,
    tasks: db.tasks
      .filter(
        (task) =>
          task.status === status &&
          (projectId === undefined || task.projectId === projectId)
      )
      .sort((a, b) => a.rank - b.rank)
      .map((task) => ({ ...task, liveRunId: liveRunOf(task.id) })),
  }));

/** The row, or the contract's 404. */
export const find = <A extends { readonly id: string }>(
  rows: readonly A[],
  entity: string,
  id: string
) => {
  const row = rows.find((candidate) => candidate.id === id);
  return row === undefined
    ? Effect.fail(new NotFound({ entity, id }))
    : Effect.succeed(row);
};

/** Replace a row in place and hand back the new one. */
export const update = <A extends { readonly id: string }>(
  rows: A[],
  next: A
) => {
  const index = rows.findIndex((row) => row.id === next.id);
  if (index >= 0) {
    rows[index] = next;
  }
  return next;
};
