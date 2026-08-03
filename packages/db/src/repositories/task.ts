/**
 * Tasks: the row three kinds of writer mutate, and the one the board is.
 *
 * The rule that lives here and nowhere above is that a column is only ever
 * reached through the domain's status machine, which is data rather than
 * conditionals. That holds for both doors into a column: a move is checked
 * against the table of transitions, and creation — which has no `from` and so
 * cannot be — is bounded by the same table, because an agent that may never
 * move a task to `done` must not be able to file one there either. Putting
 * either check in a service above the repository would leave a second door
 * open, and the manager's tools, a worker's task-scoped token and a seed script
 * all write through here.
 *
 * Editing the row is in `./task-edit` and the board's read model in
 * `./task-board`; this module creates, moves and erases a task.
 */

import {
  ActorKind,
  canCreateWithStatus,
  canDeleteTask,
  canTransition,
  DEFAULT_NEXT_SESSION,
  movesFreely,
  newTaskId,
  type Task,
  TaskId,
  type TaskMetadata,
  TaskStatus,
  type WorkspaceId,
} from "@workspace/domain";
import { and, asc, eq } from "drizzle-orm";
import { Context, DateTime, Effect, Layer, Schema } from "effect";
import { Database } from "../client";
import { decodeTask, TaskInsert, TaskUpdate } from "../rows";
import { task } from "../schema/task";
import { currentTraceparent } from "../trace";
import {
  auditCreate,
  auditDelete,
  audited,
  auditTransition,
  auditUpdate,
  changesOf,
  decodeMany,
  decodeOne,
  decodeRow,
  decodeWritten,
  encodeWrite,
  execute,
  firstRow,
  writer,
} from "./audit";
import { makeBoard } from "./task-board";
import {
  ENTITY,
  reviseWith,
  scopedTo,
  type TaskRef,
  taskEdits,
} from "./task-edit";
import { endOfColumn, rankAfter } from "./task-rank";

/** Reads addressed by id match one row; the limit says so to the planner. */
const ONE = 1;

/** Mirrors the column default: a new task is an idea until someone says otherwise. */
const DEFAULT_STATUS = "ideas" satisfies Task["status"];

/** The one column that is a dispatch trigger: entering it asks for a run. */
const DISPATCHES = "in_progress" satisfies Task["status"];

/**
 * The trace to stamp on a task landing in this column, and the reason the
 * column carries a trace at all.
 *
 * A card entering *in progress* is a request for work that will be picked up by
 * another process, seconds or a restart later — so the write that asks leaves
 * its span on the row, and the orchestrator opens the run under it. Landing
 * anywhere else clears the stamp rather than leaving it: once the card has left
 * the column nothing is being asked for, and a stale header would eventually
 * join a run to a request that ended days ago.
 */
const dispatchTraceparentFor = (status: Task["status"]) =>
  status === DISPATCHES ? currentTraceparent : Effect.succeed(null);

/**
 * The move is not in the status machine, or is but not for this kind of actor.
 * Refused as a value: an agent trying to reach `done` and a human dragging a
 * card the wrong way are the same answer, and neither is an exception.
 */
export class IllegalTransition extends Schema.TaggedErrorClass<IllegalTransition>()(
  "TaskRepo.IllegalTransition",
  { actorKind: ActorKind, from: TaskStatus, taskId: TaskId, to: TaskStatus }
) {}

/**
 * The task would have been filed into a column this actor may not reach. The
 * sibling of {@link IllegalTransition} for the other door: creating a task
 * straight into `in_progress` spends a worker slot and creating one in `done`
 * skips the human gate, so neither is an agent's to make.
 */
export class IllegalInitialStatus extends Schema.TaggedErrorClass<IllegalInitialStatus>()(
  "TaskRepo.IllegalInitialStatus",
  { actorKind: ActorKind, status: TaskStatus }
) {}

/**
 * This kind of actor may not erase a task. The third door beside
 * {@link IllegalTransition} and {@link IllegalInitialStatus}, and the one that
 * leads off the board: a run's token is good for writes on the task it was
 * dispatched for, so without this an agent could delete the card it was asked to
 * work on and take its own evidence with it.
 */
export class IllegalDeletion extends Schema.TaggedErrorClass<IllegalDeletion>()(
  "TaskRepo.IllegalDeletion",
  { actorKind: ActorKind, taskId: TaskId }
) {}

/**
 * What creating a task needs. A status is allowed here because a person and the
 * seed script file tasks straight into a column; which columns everybody else
 * may reach is the status machine's answer, asked below.
 */
export interface TaskCreate
  extends Pick<Task, "title" | "workspaceId">,
    Partial<
      Pick<
        Task,
        | "acceptance"
        | "brief"
        | "metadata"
        | "parentTaskId"
        | "projectId"
        | "prUrl"
        | "repoUrl"
        | "sandboxImage"
        | "status"
      >
    > {}

const make = Effect.gen(function* () {
  const db = yield* Database;
  const write = writer(db);
  const revise = reviseWith(write);

  const board = makeBoard(db);
  const { clearNextSession, selectNextSession, update } = taskEdits(revise);

  const create = Effect.fn("TaskRepo.create")(function* (input: TaskCreate) {
    yield* Effect.annotateCurrentSpan({ workspaceId: input.workspaceId });

    const statusChangedAt = yield* DateTime.now;
    const status = input.status ?? DEFAULT_STATUS;
    // A task can be created straight into the column — the seed script and the
    // manager both do — and that create is as much a dispatch trigger as a move.
    const dispatchTraceparent = yield* dispatchTraceparentFor(status);

    return yield* write(({ actor, tx }) =>
      Effect.gen(function* () {
        if (!canCreateWithStatus({ actorKind: actor.kind, status })) {
          return yield* Effect.fail(
            new IllegalInitialStatus({ actorKind: actor.kind, status })
          );
        }

        // A new card goes to the bottom of its column: creating a task is not a
        // statement about where it belongs in the queue, and reading the rank
        // inside the transaction is what keeps two concurrent creates apart.
        const rank = yield* endOfColumn(tx)({
          status,
          workspaceId: input.workspaceId,
        });

        const values = yield* encodeWrite({
          entity: ENTITY,
          schema: TaskInsert,
          value: {
            ...DEFAULT_NEXT_SESSION,
            acceptance: input.acceptance,
            brief: input.brief,
            dispatchTraceparent,
            id: newTaskId(),
            metadata: input.metadata ?? ({} satisfies TaskMetadata),
            parentTaskId: input.parentTaskId ?? null,
            parkedUntil: null,
            projectId: input.projectId ?? null,
            prUrl: input.prUrl,
            rank,
            repoUrl: input.repoUrl,
            sandboxImage: input.sandboxImage,
            status,
            statusChangedAt,
            title: input.title,
            workspaceId: input.workspaceId,
          },
        });

        const rows = yield* execute(
          "TaskRepo.create",
          tx.insert(task).values(values).returning()
        );

        const created = yield* decodeWritten({
          decode: decodeTask,
          entity: ENTITY,
          operation: "TaskRepo.create",
          rows,
        });

        return audited(
          created,
          auditCreate({
            entityId: created.id,
            entityType: ENTITY,
            taskId: created.id,
            workspaceId: created.workspaceId,
          })
        );
      })
    );
  });

  /**
   * Moves a task between columns, if the status machine allows this actor that
   * move. `statusChangedAt` is written alongside because "how long has this sat
   * here" is the stall signal and nothing else can answer it without scanning
   * the audit log.
   *
   * A free mover's move into `in_progress` clears `parkedUntil`: parking exists
   * to stop the dispatcher looping on a failing task, and a person — or the
   * manager asked by one — deciding to run it again is exactly the signal that
   * the loop should resume.
   */
  const transition = Effect.fn("TaskRepo.transition")(function* (
    options: TaskRef & {
      /**
       * The rank of the card this one was dropped below, `null` for the top of
       * the destination column. Omitted means the bottom, which is what an
       * ordinary status change without a gesture behind it wants.
       */
      readonly after?: number | null;
      readonly to: TaskStatus;
    }
  ) {
    yield* Effect.annotateCurrentSpan({
      taskId: options.id,
      to: options.to,
      workspaceId: options.workspaceId,
    });

    const statusChangedAt = yield* DateTime.now;
    const dispatchTraceparent = yield* dispatchTraceparentFor(options.to);

    return yield* write(({ actor, tx }) =>
      Effect.gen(function* () {
        const locked = yield* execute(
          "TaskRepo.transition",
          tx
            .select()
            .from(task)
            .where(scopedTo(options))
            .limit(ONE)
            .for("update")
        );

        const row = yield* firstRow({
          entity: ENTITY,
          id: options.id,
          rows: locked,
        });

        const before = yield* decodeRow({
          decode: decodeTask,
          entity: ENTITY,
          row,
        });

        const legal = canTransition({
          actorKind: actor.kind,
          from: before.status,
          to: options.to,
        });

        if (!legal) {
          return yield* Effect.fail(
            new IllegalTransition({
              actorKind: actor.kind,
              from: before.status,
              taskId: before.id,
              to: options.to,
            })
          );
        }

        const unparks = movesFreely(actor.kind) && options.to === DISPATCHES;

        // A card keeps no position across columns — its old rank was relative
        // to the column it left. `after` carries the drop point when the move
        // was a drag onto a spot, and its absence means the bottom.
        const rank =
          options.after === undefined
            ? yield* endOfColumn(tx)({
                status: options.to,
                workspaceId: options.workspaceId,
              })
            : yield* rankAfter(tx)({
                afterRank: options.after,
                status: options.to,
                workspaceId: options.workspaceId,
              });

        const values = yield* encodeWrite({
          entity: ENTITY,
          schema: TaskUpdate,
          value: {
            dispatchTraceparent,
            parkedUntil: unparks ? null : undefined,
            rank,
            status: options.to,
            statusChangedAt,
          },
        });

        const rows = yield* execute(
          "TaskRepo.transition",
          tx.update(task).set(values).where(scopedTo(options)).returning()
        );

        const moved = yield* decodeWritten({
          decode: decodeTask,
          entity: ENTITY,
          operation: "TaskRepo.transition",
          rows,
        });

        return audited(
          moved,
          auditTransition({
            // The move itself is the two status columns; `changes` carries what
            // else the move did, which is unparking and nothing more.
            changes: changesOf({
              after: { parkedUntil: values.parkedUntil },
              before: row,
            }),
            from: before.status,
            taskId: moved.id,
            to: moved.status,
            workspaceId: moved.workspaceId,
          })
        );
      })
    );
  });

  /**
   * Erases a task and everything hanging off it — comments, sessions, runs, run
   * events and its artifact index rows all cascade. That is what the verb
   * means, and it is why deleting is an operation of its own rather than a
   * sixth column: nothing on the board archives.
   *
   * Who may is the domain's answer and it is asked here, in the transaction,
   * for the same reason a move is: this is the door every writer comes through,
   * and a check in a service above it would leave a second one open.
   *
   * The audit row outlives the task, because `entityId` carries no foreign key.
   * It is then the only remaining evidence the task existed at all, which is
   * the whole reason an erasure is audited.
   */
  const remove = Effect.fn("TaskRepo.delete")(function* (options: TaskRef) {
    yield* Effect.annotateCurrentSpan({
      taskId: options.id,
      workspaceId: options.workspaceId,
    });

    return yield* write(({ actor, tx }) =>
      Effect.gen(function* () {
        if (!canDeleteTask({ actorKind: actor.kind })) {
          return yield* Effect.fail(
            new IllegalDeletion({ actorKind: actor.kind, taskId: options.id })
          );
        }

        const rows = yield* execute(
          "TaskRepo.delete",
          tx.delete(task).where(scopedTo(options)).returning()
        );

        const row = yield* firstRow({
          entity: ENTITY,
          id: options.id,
          rows,
        });

        const deleted = yield* decodeRow({
          decode: decodeTask,
          entity: ENTITY,
          row,
        });

        return audited(
          deleted,
          auditDelete({
            entityId: deleted.id,
            entityType: ENTITY,
            taskId: deleted.id,
            workspaceId: deleted.workspaceId,
          })
        );
      })
    );
  });

  const byId = Effect.fn("TaskRepo.byId")(function* (options: TaskRef) {
    yield* Effect.annotateCurrentSpan({
      taskId: options.id,
      workspaceId: options.workspaceId,
    });

    const rows = yield* execute(
      "TaskRepo.byId",
      db.select().from(task).where(scopedTo(options)).limit(ONE)
    );

    return yield* decodeOne({
      decode: decodeTask,
      entity: ENTITY,
      id: options.id,
      rows,
    });
  });

  /**
   * One board column, in the order the board renders it and the dispatcher
   * takes from it: by rank, oldest first where two cards share one. The index
   * is built for exactly this ordering.
   */
  const byStatus = Effect.fn("TaskRepo.byStatus")(function* (options: {
    readonly status: TaskStatus;
    readonly workspaceId: WorkspaceId;
  }) {
    yield* Effect.annotateCurrentSpan({
      status: options.status,
      workspaceId: options.workspaceId,
    });

    const rows = yield* execute(
      "TaskRepo.byStatus",
      db
        .select()
        .from(task)
        .where(
          and(
            eq(task.workspaceId, options.workspaceId),
            eq(task.status, options.status)
          )
        )
        .orderBy(asc(task.rank), asc(task.createdAt), asc(task.id))
    );

    return yield* decodeMany({ decode: decodeTask, entity: ENTITY, rows });
  });

  /**
   * Moves a card within its column. Dragging it up the board and asking the
   * manager agent to run something next are this one write: the orchestrator
   * spends its next slot on the top of `in_progress`, so position in the
   * column *is* position in the queue.
   *
   * `after` is the rank of the card to land below, and `null` means the top.
   */
  const place = Effect.fn("TaskRepo.place")(function* (
    options: TaskRef & { readonly after: number | null }
  ) {
    yield* Effect.annotateCurrentSpan({
      taskId: options.id,
      workspaceId: options.workspaceId,
    });

    return yield* write(({ tx }) =>
      Effect.gen(function* () {
        const locked = yield* execute(
          "TaskRepo.place",
          tx
            .select()
            .from(task)
            .where(scopedTo(options))
            .limit(ONE)
            .for("update")
        );

        const row = yield* firstRow({
          entity: ENTITY,
          id: options.id,
          rows: locked,
        });

        const before = yield* decodeRow({
          decode: decodeTask,
          entity: ENTITY,
          row,
        });

        const rank = yield* rankAfter(tx)({
          afterRank: options.after,
          status: before.status,
          workspaceId: options.workspaceId,
        });

        const values = yield* encodeWrite({
          entity: ENTITY,
          schema: TaskUpdate,
          value: { rank },
        });

        const rows = yield* execute(
          "TaskRepo.place",
          tx.update(task).set(values).where(scopedTo(options)).returning()
        );

        const placed = yield* decodeWritten({
          decode: decodeTask,
          entity: ENTITY,
          operation: "TaskRepo.place",
          rows,
        });

        return audited(
          placed,
          auditUpdate({
            changes: changesOf({ after: values, before: row }),
            entityId: placed.id,
            entityType: ENTITY,
            taskId: placed.id,
            workspaceId: placed.workspaceId,
          })
        );
      })
    );
  });

  return {
    board,
    byId,
    byStatus,
    clearNextSession,
    create,
    delete: remove,
    place,
    selectNextSession,
    transition,
    update,
  } as const;
});

/**
 * Tasks. Every mutation writes its audit row in the same transaction, and every
 * column a task lands in — moved into or created in — is checked against the
 * status machine first.
 */
export class TaskRepo extends Context.Service<
  TaskRepo,
  Effect.Success<typeof make>
>()("@workspace/db/TaskRepo") {
  static readonly layer = Layer.effect(TaskRepo, make);
}
