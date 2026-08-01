#!/usr/bin/env bun

/**
 * Fills an empty database with something to look at: one workspace, one
 * project, and a task in each column of the board.
 *
 * Written as the `system` actor, which exists for exactly this and nothing
 * else. It performs no transitions — the status machine has no entry for it —
 * so each task is created straight into the column it belongs in, which is the
 * same move the manager agent makes when it files work.
 *
 * Re-runnable: the workspace is found by slug rather than recreated, and the
 * projects and tasks are only written when the project is not already there.
 *
 * Usage: `bun run db:seed`. Needs the migration applied first.
 */

import { BunRuntime } from "@effect/platform-bun";
import {
  type ProjectCreate,
  ProjectRepo,
  storeLayer,
  type TaskCreate,
  TaskRepo,
  withActor,
} from "@workspace/db";
import { Actor, type ProjectId, type WorkspaceId } from "@workspace/domain";
import { Effect } from "effect";
import { ensureWorkspace } from "./store/workspace";

/** Reported as `application_name`, so `pg_stat_activity` names this process. */
const APPLICATION_NAME = "seed";

/** The seed writes as nobody in particular, and says which script it was. */
const SEEDER = Actor.cases.system.make({ reason: "seed" });

/** The project the seeded tasks belong to. Found by name on a re-run. */
const PROJECT_NAME = "Agent Task Manager";

/** The length of the longest status, so the printed lines stay in columns. */
const STATUS_WIDTH = "in_progress".length;

const projectOf = (workspaceId: WorkspaceId) =>
  ({
    description: "The factory itself. Dogfooding starts here.",
    name: PROJECT_NAME,
    repoDefaultBranch: "main",
    repoUrl: "https://github.com/Mark-Life/agent-task-manager",
    workspaceId,
  }) satisfies ProjectCreate;

/**
 * One task per column, so the board has something in every list and the
 * dispatcher has something to find. The in-progress one is deliberate: it
 * exercises the notify trigger that fires on insert as well as on a move, which
 * is the case an update-only trigger would drop on the floor.
 *
 * The last task carries no project, because a task is allowed to belong to
 * nothing — and a project is what names a repository, so this one runs in a
 * scratch directory rather than a clone.
 */
const tasksOf = (options: {
  readonly projectId: ProjectId;
  readonly workspaceId: WorkspaceId;
}) =>
  [
    {
      brief:
        "Rough notes only. Nobody has decided whether this is worth doing.",
      status: "ideas",
      title: "Let the manager agent file subtasks off one article",
      ...options,
    },
    {
      acceptance: "A run reaches the container and comes back with a PR link.",
      brief: "Port the provider abstraction rather than reinventing it.",
      status: "backlog",
      title: "Claude and Codex providers behind one normalized event model",
      ...options,
    },
    {
      brief: "Dispatch, leases, and the run lifecycle around one container.",
      status: "in_progress",
      title: "Orchestrator loop over the run table",
      ...options,
    },
    {
      brief: "Boards, run timelines, comments, session switching.",
      prUrl: "https://github.com/Mark-Life/agent-task-manager/pull/1",
      status: "review",
      title: "Dashboard reads the board from the gateway",
      ...options,
    },
    {
      brief: "Volume, port, healthcheck, no exposure beyond the host.",
      status: "done",
      title: "Postgres in a container on the box",
      ...options,
    },
    {
      brief: "Four days, museums in the morning, nothing before ten.",
      status: "ideas",
      title: "Plan the Budapest trip into the calendar",
      workspaceId: options.workspaceId,
    },
  ] satisfies readonly TaskCreate[];

const seed = Effect.gen(function* () {
  const { workspace } = yield* ensureWorkspace();
  yield* Effect.logInfo(`workspace ${workspace.name} (${workspace.id})`);

  const projects = yield* ProjectRepo;
  const tasks = yield* TaskRepo;

  const stored = yield* projects.list({ workspaceId: workspace.id });
  const existing = stored.find((found) => found.name === PROJECT_NAME);

  if (existing !== undefined) {
    yield* Effect.logInfo(
      `project ${existing.name} is already seeded — nothing to write`
    );
    return;
  }

  const project = yield* projects.create(projectOf(workspace.id));
  yield* Effect.logInfo(`project ${project.name} (${project.id})`);

  const written = yield* Effect.forEach(
    tasksOf({ projectId: project.id, workspaceId: workspace.id }),
    (input) => tasks.create(input)
  );

  yield* Effect.forEach(written, (task) =>
    Effect.logInfo(`task  ${task.status.padEnd(STATUS_WIDTH)} ${task.title}`)
  );
});

BunRuntime.runMain(
  seed.pipe(
    withActor(SEEDER),
    Effect.provide(storeLayer({ applicationName: APPLICATION_NAME }))
  )
);
