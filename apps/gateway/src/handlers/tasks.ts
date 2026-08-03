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
 * The one thing this file decides on its own is {@link runToStop}, and it
 * is decided here because it is not a rule about a task row: taking a card out
 * of `in_progress` while a container is working on it asks the orchestrator to
 * stop that container, which is a second row in a second table. The two halves
 * of the `in_progress` column are then symmetric — landing in it starts work,
 * leaving it ends work — and neither needs a button of its own.
 *
 * Reading a column is the one place the store's surface shows through: there is
 * no query for "every task" and none for "the tasks of a project", so the list
 * and the board fan out over the five statuses and filter in memory. That is
 * five indexed reads of a board a person can see at once, and it is what the
 * repository exposes today.
 */

import { Api, Principal } from "@workspace/api";
import { RunCommandRepo, TaskRepo, withActor } from "@workspace/db";
import {
  type Actor,
  movesFreely,
  type ProjectId,
  type RunId,
  TASK_STATUSES,
  type Task,
  type TaskId,
  type TaskStatus,
  type WorkspaceId,
} from "@workspace/domain";
import { Effect } from "effect";
import { HttpApiBuilder } from "effect/unstable/httpapi";
import {
  storeDefects,
  toIllegalDeletion,
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

/** The column a run is dispatched from, and therefore the one leaving ends work. */
const DISPATCHES = "in_progress" satisfies TaskStatus;

/** What a move has to be for the run under it to be asked to stop. */
interface LeavingWork {
  readonly actor: Actor;
  readonly from: TaskStatus;
  readonly liveRunId: RunId | null;
  readonly to: TaskStatus;
}

/**
 * The run this move takes the card out from under, or null when the move leaves
 * nothing running.
 *
 * Only a person's move, or the manager's on their behalf. A run ending its own
 * work moves the same card out of the same column, and asking the orchestrator
 * to stop the run that just finished would put a refusal on the board for
 * something nobody asked for.
 */
const runToStop = (move: LeavingWork): RunId | null =>
  movesFreely(move.actor.kind) &&
  move.from === DISPATCHES &&
  move.to !== DISPATCHES
    ? move.liveRunId
    : null;

/**
 * The `tasks` group, implemented.
 *
 * The repositories are taken once, at layer build, because each is a handle on
 * the process's connection pool. Who is calling is read per request and provided
 * to every write, so the audit row the repository writes in the same transaction
 * names the caller rather than the gateway.
 */
export const tasksHandlers = HttpApiBuilder.group(Api, "tasks", (handlers) =>
  Effect.gen(function* () {
    const tasks = yield* TaskRepo;
    const commands = yield* RunCommandRepo;

    /**
     * Asks the orchestrator to kill the container working on this task.
     *
     * The same row the Stop button writes, attributed to whoever moved the card,
     * so a stop that came from a drag and a stop that came from a button are one
     * thing in the command history. Nothing here touches a container: the
     * orchestrator claims the row, and a stop it cannot act on is recorded on the
     * row as a refusal rather than raised at the person who moved the card.
     */
    const requestStop = (input: {
      readonly actor: Actor;
      readonly runId: RunId;
      readonly taskId: TaskId;
      readonly workspaceId: WorkspaceId;
    }) =>
      commands
        .enqueue({
          payload: { kind: "stop" },
          runId: input.runId,
          subject: { id: input.taskId, kind: "task" },
          workspaceId: input.workspaceId,
        })
        .pipe(
          withActor(input.actor),
          // The payload is a constant this file wrote, so a store that refuses
          // it is a bug here rather than an answer for the caller.
          Effect.catchTags({ ...storeDefects, "Db.InvalidInput": Effect.die }),
          Effect.asVoid
        );

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
              "TaskRepo.IllegalDeletion": toIllegalDeletion,
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
      //
      // The board view is read first because a move out of `in_progress` has a
      // second half: the column the card is leaving and the run working on it
      // are both gone from the answer by the time the write returns, and the two
      // of them together are what say whether a container has to be asked to
      // stop. A card somebody else moved in between is the same race the move
      // itself has, and the repository settles it — this read only ever decides
      // whether one more row is written.
      transition: ({ params, payload }) =>
        Effect.gen(function* () {
          const { actor, workspaceId } = yield* Principal;
          const before = yield* tasks
            .board({ id: params.taskId, workspaceId })
            .pipe(
              Effect.catchTags({ ...storeDefects, "Db.NotFound": toNotFound })
            );

          const moved = yield* tasks
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

          const stopping = runToStop({
            actor,
            from: before.task.status,
            liveRunId: before.liveRunId,
            to: moved.status,
          });
          if (stopping !== null) {
            yield* requestStop({
              actor,
              runId: stopping,
              taskId: moved.id,
              workspaceId,
            });
          }

          return moved;
        }),
    });
  })
);
