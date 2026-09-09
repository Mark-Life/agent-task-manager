/**
 * A task on the wire, and the four shapes that are about where it sits rather
 * than what it says: the detail view, a board card, one board column, and the
 * next-session selection.
 *
 * Everything derives from `@workspace/domain`. The one restatement is
 * {@link TaskDetail}, which mirrors the store's board view — a value the store
 * assembles from three tables and this package may not import.
 */

import {
  NextSession as DomainNextSession,
  Task as DomainTask,
  RunId,
  TaskStatus,
} from "@workspace/domain";
import { Schema } from "effect";
import { Project } from "./project";

/** A task, exactly as the store holds it. */
export const Task = DomainTask.annotate({ identifier: "Task" });

export interface Task extends Schema.Schema.Type<typeof Task> {}

/**
 * A task with the two things a reader always needs beside it: the project it
 * belongs to, and the run working on it right now if there is one.
 *
 * The live run is named by id rather than handed over whole — a task page that
 * wants the run's economics asks for the run. `liveRunId` being null while the
 * task sits in `in_progress` is the real state the board draws differently:
 * waiting for a slot, or stalled.
 */
export const TaskDetail = Schema.Struct({
  liveRunId: Schema.NullOr(RunId),
  project: Schema.NullOr(Project),
  task: Task,
}).annotate({ identifier: "TaskDetail" });

export interface TaskDetail extends Schema.Schema.Type<typeof TaskDetail> {}

/**
 * A card on the board: the task, and the one fact about it that is not on its
 * row — the run working on it right now.
 *
 * Flat rather than `{ liveRunId, task }` because the board draws cards and not
 * pairs, and because the field answers the same question {@link TaskDetail}
 * answers with the same name and the same null: a card in `in_progress` with no
 * live run is waiting for a slot or has stalled, which is the difference the
 * spinner is.
 *
 * It is on the board's own read for one reason: without it a dashboard has to
 * ask `/tasks/:taskId` once per card in progress to find out, on a timer, which
 * was this gateway's second-largest source of requests.
 */
export const BoardCard = Schema.Struct({
  ...DomainTask.fields,
  liveRunId: Schema.NullOr(RunId),
}).annotate({ identifier: "BoardCard" });

export interface BoardCard extends Schema.Schema.Type<typeof BoardCard> {}

/**
 * One column of the board: its status and its cards in the order they are
 * rendered, which is also the order the dispatcher takes from `in_progress`.
 */
export const BoardColumn = Schema.Struct({
  status: TaskStatus,
  tasks: Schema.Array(BoardCard),
}).annotate({ identifier: "BoardColumn" });

export interface BoardColumn extends Schema.Schema.Type<typeof BoardColumn> {}

/**
 * What filing a task takes. `status` is allowed because a person files
 * straight into a column; which columns a given caller may reach is the status
 * machine's answer and the store asks it.
 */
export const TaskCreate = Schema.Struct({
  acceptance: Schema.optionalKey(DomainTask.fields.acceptance),
  brief: Schema.optionalKey(DomainTask.fields.brief),
  metadata: Schema.optionalKey(DomainTask.fields.metadata),
  parentTaskId: Schema.optionalKey(DomainTask.fields.parentTaskId),
  projectId: Schema.optionalKey(DomainTask.fields.projectId),
  prUrl: Schema.optionalKey(DomainTask.fields.prUrl),
  repoUrl: Schema.optionalKey(DomainTask.fields.repoUrl),
  sandboxImage: Schema.optionalKey(DomainTask.fields.sandboxImage),
  status: Schema.optionalKey(DomainTask.fields.status),
  title: DomainTask.fields.title,
}).annotate({ identifier: "TaskCreate" });

export interface TaskCreate extends Schema.Schema.Type<typeof TaskCreate> {}

/**
 * What ordinary editing may change: whatever creation could set, less the
 * status, which moves through the status machine and has its own operation.
 * `parkedUntil` is absent too — parking is the dispatcher's, and a person
 * un-parks a task by moving it, not by patching a timestamp.
 */
export const TaskPatch = Schema.Struct({
  acceptance: Schema.optionalKey(DomainTask.fields.acceptance),
  brief: Schema.optionalKey(DomainTask.fields.brief),
  metadata: Schema.optionalKey(DomainTask.fields.metadata),
  parentTaskId: Schema.optionalKey(DomainTask.fields.parentTaskId),
  projectId: Schema.optionalKey(DomainTask.fields.projectId),
  prUrl: Schema.optionalKey(DomainTask.fields.prUrl),
  repoUrl: Schema.optionalKey(DomainTask.fields.repoUrl),
  sandboxImage: Schema.optionalKey(DomainTask.fields.sandboxImage),
  title: Schema.optionalKey(DomainTask.fields.title),
}).annotate({ identifier: "TaskPatch" });

export interface TaskPatch extends Schema.Schema.Type<typeof TaskPatch> {}

/**
 * A move on the board. `after` is the rank of the card this one was dropped
 * below and `null` means the top of the destination column; omitting it lands
 * at the bottom, which is what a status change with no gesture behind it wants.
 */
export const TaskTransition = Schema.Struct({
  after: Schema.optionalKey(Schema.NullOr(DomainTask.fields.rank)),
  to: TaskStatus,
}).annotate({ identifier: "TaskTransition" });

export interface TaskTransition
  extends Schema.Schema.Type<typeof TaskTransition> {}

/**
 * A move within a column, which is the same write as changing the dispatch
 * queue: the orchestrator spends its next slot on the top of `in_progress`, so
 * position in the column is position in the queue.
 */
export const TaskPlacement = Schema.Struct({
  after: Schema.NullOr(DomainTask.fields.rank),
}).annotate({ identifier: "TaskPlacement" });

export interface TaskPlacement
  extends Schema.Schema.Type<typeof TaskPlacement> {}

/**
 * Which session the next run on this task uses: continue the latest, start a
 * fresh one, or resume one named session. A property of the task rather than an
 * argument at dispatch, so a dropdown and a sentence to the manager write the
 * same value.
 */
export const NextSession = DomainNextSession.annotate({
  identifier: "NextSession",
});

export type NextSession = typeof NextSession.Type;
