/**
 * Tasks: the board, and the moves a card makes on it.
 *
 * The three move operations stay three, and none of them re-decides anything.
 * `transition` hands the move to the repository, which owns the status machine
 * and refuses a move that is not in it or not this actor's to make — including
 * the one that matters most, since moving a card into `in_progress` *is* the
 * trigger and the orchestrator picks the row up without a second confirmation.
 * `place` is one row write of the midpoint between two neighbours, which is why
 * dragging a card up the column and telling the manager agent to run something
 * next are the same call. `selectNextSession` writes the two columns that say
 * what the next run does.
 *
 * Reading a column is the one place the store's surface shows through: there is
 * no query for "every task" and none for "the tasks of a project", so the list
 * and the board fan out over the five statuses and filter in memory. That is
 * five indexed reads of a board a person can see at once, and it is what the
 * repository exposes today.
 */

import { Api, Principal } from "@workspace/api";
import { TaskRepo, withActor } from "@workspace/db";
import {
  type ProjectId,
  TASK_STATUSES,
  type Task,
  type TaskStatus,
  type WorkspaceId,
} from "@workspace/domain";
import { Effect } from "effect";
import { HttpApiBuilder } from "effect/unstable/httpapi";
import {
  storeDefects,
  toIllegalInitialStatus,
  toIllegalTransition,
  toInvalidInput,
  toNotFound,
} from "./store-failures";

/** Which column a read covers, and which project it is narrowed to. */
interface ColumnQuery {
  readonly projectId?: ProjectId | undefined;
  readonly status?: TaskStatus | undefined;
  readonly workspaceId: WorkspaceId;
}

/** The columns a query covers, in the order the board renders them. */
const columnsOf = (query: ColumnQuery) =>
  query.status === undefined ? TASK_STATUSES : [query.status];

/**
 * Narrows a column to one project. In memory because the store indexes a column
 * by `(workspace, status, rank)` and has no query keyed by project — a filter
 * over one column of one workspace is small, and a partial answer would not be.
 */
const inProject = (projectId: ProjectId | undefined) => (task: Task) =>
  projectId === undefined || task.projectId === projectId;

/**
 * The `tasks` group, implemented.
 *
 * The repository is taken once, at layer build, because it is a handle on the
 * process's connection pool. Who is calling is read per request and provided to
 * every write, so the audit row the repository writes in the same transaction
 * names the caller rather than the gateway.
 */
export const tasksHandlers = HttpApiBuilder.group(Api, "tasks", (handlers) =>
  Effect.gen(function* () {
    const tasks = yield* TaskRepo;

    /** One column, or every column, already narrowed to the project asked for. */
    const readColumns = (query: ColumnQuery) =>
      Effect.forEach(columnsOf(query), (status) =>
        Effect.map(
          tasks.byStatus({ status, workspaceId: query.workspaceId }),
          (column) => ({
            status,
            tasks: column.filter(inProject(query.projectId)),
          })
        )
      );

    return handlers.handleAll({
      board: ({ query }) =>
        Effect.gen(function* () {
          const { workspaceId } = yield* Principal;
          return yield* readColumns({ ...query, workspaceId }).pipe(
            Effect.catchTags(storeDefects)
          );
        }),

      create: ({ payload }) =>
        Effect.gen(function* () {
          const { actor, workspaceId } = yield* Principal;
          return yield* tasks.create({ ...payload, workspaceId }).pipe(
            withActor(actor),
            Effect.catchTags({
              ...storeDefects,
              "Db.InvalidInput": toInvalidInput,
              "TaskRepo.IllegalInitialStatus": toIllegalInitialStatus,
            })
          );
        }),

      // Everything hanging off the task goes with it — the thread, the
      // sessions, the runs. The audit row does not: it outlives the row it
      // describes, and after this it is the only evidence the task existed.
      //
      // A delete sends no body, so the only thing left that could be refused as
      // invalid input is the audit row this process builds itself, which makes
      // it a defect rather than an answer.
      delete: ({ params }) =>
        Effect.gen(function* () {
          const { actor, workspaceId } = yield* Principal;
          return yield* tasks.delete({ id: params.taskId, workspaceId }).pipe(
            withActor(actor),
            Effect.catchTags({
              ...storeDefects,
              "Db.InvalidInput": Effect.die,
              "Db.NotFound": toNotFound,
            }),
            Effect.asVoid
          );
        }),

      // The board view rather than the row: the project a task belongs to and
      // the run working on it right now are what every reader needs next, and
      // the store answers all three together.
      get: ({ params }) =>
        Effect.gen(function* () {
          const { workspaceId } = yield* Principal;
          return yield* tasks.board({ id: params.taskId, workspaceId }).pipe(
            Effect.catchTags({
              ...storeDefects,
              "Db.NotFound": toNotFound,
            })
          );
        }),

      list: ({ query }) =>
        Effect.gen(function* () {
          const { workspaceId } = yield* Principal;
          const columns = yield* readColumns({ ...query, workspaceId }).pipe(
            Effect.catchTags(storeDefects)
          );
          return columns.flatMap((column) => column.tasks);
        }),

      patch: ({ params, payload }) =>
        Effect.gen(function* () {
          const { actor, workspaceId } = yield* Principal;
          return yield* tasks
            .update({ fields: payload, id: params.taskId, workspaceId })
            .pipe(
              withActor(actor),
              Effect.catchTags({
                ...storeDefects,
                "Db.InvalidInput": toInvalidInput,
                "Db.NotFound": toNotFound,
              })
            );
        }),

      // A placement writes one rank and nothing else, so what it could refuse
      // as invalid input is the audit row alone: a defect, not an answer.
      place: ({ params, payload }) =>
        Effect.gen(function* () {
          const { actor, workspaceId } = yield* Principal;
          return yield* tasks
            .place({ after: payload.after, id: params.taskId, workspaceId })
            .pipe(
              withActor(actor),
              Effect.catchTags({
                ...storeDefects,
                "Db.InvalidInput": Effect.die,
                "Db.NotFound": toNotFound,
              })
            );
        }),

      selectNextSession: ({ params, payload }) =>
        Effect.gen(function* () {
          const { actor, workspaceId } = yield* Principal;
          return yield* tasks
            .selectNextSession({
              id: params.taskId,
              next: payload,
              workspaceId,
            })
            .pipe(
              withActor(actor),
              Effect.catchTags({
                ...storeDefects,
                "Db.InvalidInput": toInvalidInput,
                "Db.NotFound": toNotFound,
              })
            );
        }),

      // `after` absent means the bottom of the destination column, which is
      // what a status change with no gesture behind it wants; `null` means the
      // top. The repository reads that difference, so the key is passed through
      // exactly as it arrived.
      transition: ({ params, payload }) =>
        Effect.gen(function* () {
          const { actor, workspaceId } = yield* Principal;
          return yield* tasks
            .transition({
              after: payload.after,
              id: params.taskId,
              to: payload.to,
              workspaceId,
            })
            .pipe(
              withActor(actor),
              Effect.catchTags({
                ...storeDefects,
                "Db.InvalidInput": Effect.die,
                "Db.NotFound": toNotFound,
                "TaskRepo.IllegalTransition": toIllegalTransition,
              })
            );
        }),
    });
  })
);
