/**
 * Editing a task in place: everything that changes the row without moving it
 * between columns.
 *
 * Every such write has the same shape — lock the row, write the patch, record
 * what actually moved against what was stored — so it is written once here
 * rather than repeated per operation, where the lock or the diff would
 * eventually be forgotten. A patch that would set nothing is refused before the
 * builder is touched, since an `UPDATE` with no assignments is not a statement
 * the driver can build.
 *
 * Which session runs next lives here too. It is one decision spread across two
 * columns rather than two fields anyone may patch a piece at a time: a
 * dropdown in the dashboard and a sentence to the manager agent both end up
 * writing it, and the orchestrator clears it once it has claimed the task.
 */

import {
  DEFAULT_NEXT_SESSION,
  type NextSession,
  nextSessionColumns,
  type Task,
  type TaskId,
  type WorkspaceId,
} from "@workspace/domain";
import { and, eq } from "drizzle-orm";
import { Effect } from "effect";
import { decodeTask, TaskUpdate } from "../rows";
import { task } from "../schema/task";
import {
  audited,
  auditUpdate,
  type BrandedEncoded,
  changesOf,
  decodeWritten,
  encodeWrite,
  execute,
  firstRow,
  writableValues,
  type writer,
} from "./audit";
import type { TaskCreate } from "./task";

/** Reads addressed by id match one row; the limit says so to the planner. */
const ONE = 1;

/** The table these rows live in, and what an error names them as. */
export const ENTITY = "task";

/** A task is never addressed by id alone: every query names its workspace. */
export interface TaskRef {
  readonly id: TaskId;
  readonly workspaceId: WorkspaceId;
}

/**
 * What ordinary editing may change: whatever creation could set, less the
 * status, which moves through the status machine, and less the workspace, which
 * a row cannot leave without stranding every child a composite foreign key
 * holds to it. Parking joins the list because the retry threshold has to write
 * it. The next-session columns are absent — they are set and cleared as one
 * decision rather than patched a field at a time.
 */
export interface TaskPatch
  extends Partial<Omit<TaskCreate, "status" | "workspaceId">>,
    Partial<Pick<Task, "parkedUntil">> {}

/** The scoping every query on this table carries, in one place. */
export const scopedTo = (ref: TaskRef) =>
  and(eq(task.workspaceId, ref.workspaceId), eq(task.id, ref.id));

/** The audited write path, as `writer` binds it to one database handle. */
type Write = ReturnType<typeof writer>;

/**
 * Locks the row, writes the patch, and records what actually moved. Every
 * change to a task that is not a status move goes through here, so the lock,
 * the diff and the audit row cannot be forgotten one operation at a time.
 */
export const reviseWith =
  (write: Write) =>
  (operation: string) =>
  (options: TaskRef & { readonly values: BrandedEncoded<typeof TaskUpdate> }) =>
    Effect.gen(function* () {
      // Before the transaction, because a request that changes nothing is not
      // worth a BEGIN — and because the driver throws where it builds an
      // `UPDATE` with no assignments, outside every Effect boundary.
      const values = yield* writableValues({
        entity: ENTITY,
        values: options.values,
      });

      return yield* write(({ tx }) =>
        Effect.gen(function* () {
          const locked = yield* execute(
            operation,
            tx
              .select()
              .from(task)
              .where(scopedTo(options))
              .limit(ONE)
              .for("update")
          );

          const before = yield* firstRow({
            entity: ENTITY,
            id: options.id,
            rows: locked,
          });

          const rows = yield* execute(
            operation,
            tx.update(task).set(values).where(scopedTo(options)).returning()
          );

          const updated = yield* decodeWritten({
            decode: decodeTask,
            entity: ENTITY,
            operation,
            rows,
          });

          return audited(
            updated,
            auditUpdate({
              changes: changesOf({ after: values, before }),
              entityId: updated.id,
              entityType: ENTITY,
              taskId: updated.id,
              workspaceId: updated.workspaceId,
            })
          );
        })
      );
    });

/** How a repository method reaches the shape above. */
type Revise = ReturnType<typeof reviseWith>;

/**
 * The three operations built on it. They are handed the bound `revise` rather
 * than the handle, so there is one place a task's row is locked and diffed and
 * this module cannot open a second one.
 */
export const taskEdits = (revise: Revise) => {
  const update = Effect.fn("TaskRepo.update")(function* (
    options: TaskRef & { readonly fields: TaskPatch }
  ) {
    yield* Effect.annotateCurrentSpan({
      taskId: options.id,
      workspaceId: options.workspaceId,
    });

    const values = yield* encodeWrite({
      entity: ENTITY,
      schema: TaskUpdate,
      value: options.fields,
    });

    return yield* revise("TaskRepo.update")({ ...options, values });
  });

  /**
   * Pins what the next run on this task does: continue the latest session,
   * start a fresh one, or resume one particular session. Both columns are
   * written together, so an inconsistent selection — pin this session and also
   * start a fresh one — cannot be expressed.
   */
  const selectNextSession = Effect.fn("TaskRepo.selectNextSession")(function* (
    options: TaskRef & { readonly next: NextSession }
  ) {
    yield* Effect.annotateCurrentSpan({
      mode: options.next.mode,
      taskId: options.id,
      workspaceId: options.workspaceId,
    });

    const values = yield* encodeWrite({
      entity: ENTITY,
      schema: TaskUpdate,
      value: nextSessionColumns(options.next),
    });

    return yield* revise("TaskRepo.selectNextSession")({ ...options, values });
  });

  /**
   * Puts the selection back to the default. The orchestrator calls this once it
   * has claimed a task and honoured whatever was pinned, so a selection is
   * spent by the run it chose rather than sticking to every run after it.
   */
  const clearNextSession = Effect.fn("TaskRepo.clearNextSession")(function* (
    options: TaskRef
  ) {
    yield* Effect.annotateCurrentSpan({
      taskId: options.id,
      workspaceId: options.workspaceId,
    });

    const values = yield* encodeWrite({
      entity: ENTITY,
      schema: TaskUpdate,
      value: DEFAULT_NEXT_SESSION,
    });

    return yield* revise("TaskRepo.clearNextSession")({ ...options, values });
  });

  return { clearNextSession, selectNextSession, update } as const;
};
