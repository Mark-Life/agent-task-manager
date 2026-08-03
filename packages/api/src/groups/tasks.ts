/**
 * Tasks: the board, and the four ways a card moves on it.
 *
 * Reading a task gives you {@link TaskDetail} rather than the bare row, because
 * the project it belongs to and the run working on it right now are what every
 * reader needs next, and the store answers all three in one query.
 *
 * Moving a card is three distinct operations rather than a patch, because they
 * are three distinct decisions: `transition` runs the status machine and is
 * refused when the move or the actor is wrong, `place` reorders within a column
 * and is therefore the dispatch queue, and `next-session` says what the next run
 * on the task does. A patch that could set `status` would be a fourth door into
 * the status machine with none of its rules.
 */

import { ProjectId, TaskId, TaskStatus } from "@workspace/domain";
import { Schema } from "effect";
import {
  HttpApiEndpoint,
  HttpApiGroup,
  OpenApi,
} from "effect/unstable/httpapi";
import {
  IllegalDeletion,
  IllegalInitialStatus,
  IllegalTransition,
  InvalidInput,
  NotFound,
} from "../errors";
import {
  BoardColumn,
  NextSession,
  Task,
  TaskCreate,
  TaskDetail,
  TaskPatch,
  TaskPlacement,
  TaskTransition,
} from "../schemas/task";
import { ReadAccess, TaskWriteAccess } from "../security";

/**
 * A flat list, filtered. Both filters are optional and they compose: no filter
 * is the whole workspace, oldest column first, each column by rank.
 */
const list = HttpApiEndpoint.get("list", "/tasks", {
  query: {
    projectId: Schema.optionalKey(ProjectId),
    status: Schema.optionalKey(TaskStatus),
  },
  success: Schema.Array(Task),
})
  .middleware(ReadAccess)
  .annotate(OpenApi.Summary, "List tasks, optionally by status or project");

/**
 * The whole board in one call: five columns, each in the order it renders.
 * Separate from {@link list} because a board is not a filtered list — it is
 * every column at once, and asking for it five times is five round trips the
 * dashboard would make on every refresh.
 */
const board = HttpApiEndpoint.get("board", "/tasks/board", {
  query: { projectId: Schema.optionalKey(ProjectId) },
  success: Schema.Array(BoardColumn),
})
  .middleware(ReadAccess)
  .annotate(OpenApi.Summary, "The board, column by column");

/** One task, its project, and the run working on it right now if there is one. */
const get = HttpApiEndpoint.get("get", "/tasks/:taskId", {
  error: NotFound,
  params: { taskId: TaskId },
  success: TaskDetail,
})
  .middleware(ReadAccess)
  .annotate(OpenApi.Summary, "Get a task with its project and live run");

/**
 * File a new one. A status may be named, and the status machine decides whether
 * this caller may reach that column — creating a task straight into
 * `in_progress` spends a worker slot, and creating one in `done` skips the human
 * gate.
 */
const create = HttpApiEndpoint.post("create", "/tasks", {
  error: [IllegalInitialStatus, InvalidInput],
  payload: TaskCreate,
  success: Task,
})
  .middleware(TaskWriteAccess)
  .annotate(OpenApi.Summary, "Create a task");

/** Change what a task says. Not where it sits: that is the next three. */
const patch = HttpApiEndpoint.patch("patch", "/tasks/:taskId", {
  error: [InvalidInput, NotFound],
  params: { taskId: TaskId },
  payload: TaskPatch,
  success: Task,
})
  .middleware(TaskWriteAccess)
  .annotate(OpenApi.Summary, "Update a task");

/**
 * Move it to another column. A person and the manager reach every column from
 * every other one, in either direction; what is still refused is a run reaching
 * past the one move it has, and a move to the column the card is already in,
 * which is a placement rather than a transition.
 */
const transition = HttpApiEndpoint.post("transition", "/tasks/:taskId/status", {
  error: [IllegalTransition, NotFound],
  params: { taskId: TaskId },
  payload: TaskTransition,
  success: Task,
})
  .middleware(TaskWriteAccess)
  .annotate(OpenApi.Summary, "Move a task to another status");

/**
 * Move it within its column, which is what "run this one next" means: the
 * orchestrator spends its next slot on the top of `in_progress`.
 */
const place = HttpApiEndpoint.post("place", "/tasks/:taskId/place", {
  error: NotFound,
  params: { taskId: TaskId },
  payload: TaskPlacement,
  success: Task,
})
  .middleware(TaskWriteAccess)
  .annotate(OpenApi.Summary, "Reorder a task within its column");

/**
 * Pin what the next run does: continue the latest session, start a fresh one —
 * how "a new session reviews the PR it did not write" is expressed — or resume
 * one named session. The orchestrator honours it once and puts it back to the
 * default, so a selection is spent by the run it chose.
 */
const selectNextSession = HttpApiEndpoint.put(
  "selectNextSession",
  "/tasks/:taskId/next-session",
  {
    error: [InvalidInput, NotFound],
    params: { taskId: TaskId },
    payload: NextSession,
    success: Task,
  }
)
  .middleware(TaskWriteAccess)
  .annotate(OpenApi.Summary, "Choose the session the next run uses");

/**
 * Remove it, and its whole thread, its sessions and every run on it with it.
 *
 * Ordinary work rather than the destructive scope, because the manager agent
 * clears cards off a board on somebody's say-so and the alternative is minting
 * it a credential that could also delete a project. Who may is checked past the
 * scope, on the actor: a person and the manager, and no run — a worker's token
 * is good for writes on the task it was dispatched for, which without that
 * check would include erasing it.
 */
const remove = HttpApiEndpoint.delete("delete", "/tasks/:taskId", {
  error: [IllegalDeletion, NotFound],
  params: { taskId: TaskId },
})
  .middleware(TaskWriteAccess)
  .annotate(OpenApi.Summary, "Delete a task");

/** The board, and everything about where a card sits on it. */
export class TasksGroup extends HttpApiGroup.make("tasks")
  .add(
    list,
    board,
    get,
    create,
    patch,
    transition,
    place,
    selectNextSession,
    remove
  )
  .annotate(
    OpenApi.Description,
    "Tasks: the board, and the moves a card can make on it."
  ) {}
