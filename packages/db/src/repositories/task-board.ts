/**
 * One task with what the board draws around it.
 *
 * It is apart from the task's own reads because it is a different question:
 * whether an agent is working right now is a fact about the run table, not
 * about the column the card sits in, and a task in `in_progress` with no live
 * run is waiting for a slot or has stalled. The spinner is that difference, and
 * reading it takes two more tables than a task does.
 */

import {
  LIVE_RUN_STATUSES,
  type Project,
  RunId,
  type Task,
} from "@workspace/domain";
import { and, eq, inArray } from "drizzle-orm";
import { Effect, Schema } from "effect";
import { decodeProject, decodeTask } from "../rows";
import { project } from "../schema/project";
import { run } from "../schema/run";
import { task } from "../schema/task";
import type { DatabaseHandle } from "./audit";
import { decodeRow, execute, firstRow } from "./audit";
import { ENTITY, scopedTo, type TaskRef } from "./task-edit";

/** The task, its project and its live run are one row each. */
const ONE = 1;

const liveStatuses = [...LIVE_RUN_STATUSES];

const decodeRunId = Schema.decodeUnknownEffect(RunId);

/**
 * A task, the project it belongs to, and the run working on it right now if
 * there is one. The run is named by id rather than handed over whole, so this
 * repository does not start returning somebody else's aggregate.
 */
export interface TaskBoardView {
  readonly liveRunId: RunId | null;
  readonly project: Project | null;
  readonly task: Task;
}

/** Builds the read over one handle. Nothing here writes, so there is no actor. */
export const makeBoard = (db: DatabaseHandle) =>
  Effect.fn("TaskRepo.board")(function* (options: TaskRef) {
    yield* Effect.annotateCurrentSpan({
      taskId: options.id,
      workspaceId: options.workspaceId,
    });

    const rows = yield* execute(
      "TaskRepo.board",
      db
        .select()
        .from(task)
        .leftJoin(
          project,
          and(
            eq(project.workspaceId, task.workspaceId),
            eq(project.id, task.projectId)
          )
        )
        .where(scopedTo(options))
        .limit(ONE)
    );

    const row = yield* firstRow({
      entity: ENTITY,
      id: options.id,
      rows,
    });

    const live = yield* execute(
      "TaskRepo.board",
      db
        .select({ id: run.id })
        .from(run)
        .where(
          and(
            eq(run.workspaceId, options.workspaceId),
            eq(run.taskId, options.id),
            inArray(run.status, liveStatuses)
          )
        )
        .limit(ONE)
    );

    const [held] = live;

    return {
      liveRunId:
        held === undefined
          ? null
          : yield* decodeRow({
              decode: decodeRunId,
              entity: "run",
              row: held.id,
            }),
      project:
        row.project === null
          ? null
          : yield* decodeRow({
              decode: decodeProject,
              entity: "project",
              row: row.project,
            }),
      task: yield* decodeRow({
        decode: decodeTask,
        entity: ENTITY,
        row: row.task,
      }),
    } satisfies TaskBoardView;
  });
