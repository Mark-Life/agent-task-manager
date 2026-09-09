/**
 * The cached state of a task's pull request: the one read that needs the stored
 * ETag, and the one write that replaces the state with a newer answer.
 *
 * Two properties are what this file is for, and both are about what *not* to
 * write.
 *
 * **A write happens only when the state actually changed.** The refresh runs
 * every couple of minutes for every open pull request somebody is looking at,
 * and every write to `task` carries an audit row. Stamping "checked, still
 * open" on the row would put thirty of those rows an hour into a log whose only
 * value is that it is not noise. So the row records transitions — draft became
 * open, open became merged — which is a thing that happened to the card and
 * belongs in the log; how recently GitHub was *asked* is the refresher's own
 * business and lives in its memory.
 *
 * **The write is guarded on the URL it was fetched for.** A lookup is a network
 * round trip, and a person can retarget `pr_url` while one is in flight — so the
 * state of the pull request that was asked about must not land on the card that
 * now points at a different one. The check happens under the same row lock as
 * the write, so there is no window between them.
 */

import type { PrState, Timestamp } from "@workspace/domain";
import { DateTime, Effect, Schema } from "effect";
import { decodeTaskRow, TaskUpdate } from "../rows";
import { task } from "../schema/task";
import {
  audited,
  auditUpdate,
  changesOf,
  decodeWritten,
  encodeWrite,
  execute,
  firstRow,
  type writer,
} from "./audit";
import { ENTITY, scopedTo, type TaskRef } from "./task-edit";

/** Reads addressed by id match one row; the limit says so to the planner. */
const ONE = 1;

/**
 * What the refresher needs to know before it asks GitHub anything: which pull
 * request the card points at now, what was last recorded about it, and the
 * validator to send back so an unchanged answer costs nothing.
 */
export interface TaskPrCache {
  /** GitHub's ETag for the response {@link prState} was read from. */
  readonly prEtag: string | null;
  readonly prState: PrState | null;
  /**
   * When {@link prState} was recorded — a lower bound on its freshness, not the
   * last time GitHub was asked. See the note at the top of this file.
   */
  readonly prStateAt: Timestamp | null;
  readonly prUrl: string | null;
}

/** A state read from GitHub, against the URL it was read for. */
export interface PrStateRecord extends TaskRef {
  /** The validator to send as `If-None-Match` next time, when GitHub gave one. */
  readonly etag: string | null;
  /** The card's URL as it stood when the lookup began. A row that has moved on is left alone. */
  readonly prUrl: string;
  readonly state: PrState;
}

/**
 * The row moved under the lookup, or the state it came back with is the state
 * already stored. Never leaves this module: `recordPrState` catches it and
 * answers `false`, because neither case is anything the caller can act on and
 * both mean the same thing — nothing was written.
 */
class NothingToRecord extends Schema.TaggedErrorClass<NothingToRecord>()(
  "TaskRepo.NothingToRecord",
  {}
) {}

/** The audited write path, as `writer` binds it to one database handle. */
type Write = ReturnType<typeof writer>;

/** The handle the read is built over, as `Database` holds it. */
type Handle = Parameters<typeof writer>[0];

export const taskPrState = (db: Handle, write: Write) => {
  /**
   * What is stored about this task's pull request, or null for a task that is
   * not there any more.
   *
   * Null rather than {@link NotFound} because every caller is a background
   * refresh reacting to a board read that has already happened: a card deleted
   * in between is a refresh with nothing to do, not a failure anybody asked
   * for.
   */
  const prCache = Effect.fn("TaskRepo.prCache")(function* (options: TaskRef) {
    yield* Effect.annotateCurrentSpan({
      taskId: options.id,
      workspaceId: options.workspaceId,
    });

    // The whole row rather than the four columns, so the answer goes through
    // the schema that describes the table instead of a second one that would
    // have to be kept in step with it. It is one primary key lookup either way.
    const rows = yield* execute(
      "TaskRepo.prCache",
      db.select().from(task).where(scopedTo(options)).limit(ONE)
    );

    const [row] = rows;
    if (row === undefined) {
      return null;
    }
    const decoded = yield* decodeTaskRow(row);
    return {
      prEtag: decoded.prEtag,
      prState: decoded.prState,
      prStateAt: decoded.prStateAt,
      prUrl: decoded.prUrl,
    } satisfies TaskPrCache;
  });

  /**
   * Stores a state GitHub just gave, if it is news and if the card still points
   * at the pull request it describes.
   *
   * Answers whether it wrote. `false` is the ordinary outcome — a pull request
   * that is still open is the common case, and it is the case that must not
   * touch the row.
   */
  const recordPrState = Effect.fn("TaskRepo.recordPrState")(function* (
    input: PrStateRecord
  ) {
    yield* Effect.annotateCurrentSpan({
      prState: input.state,
      taskId: input.id,
      workspaceId: input.workspaceId,
    });

    const prStateAt = yield* DateTime.now;

    const values = yield* encodeWrite({
      entity: ENTITY,
      schema: TaskUpdate,
      value: {
        prEtag: input.etag,
        prState: input.state,
        prStateAt,
      },
    });

    return yield* write(({ tx }) =>
      Effect.gen(function* () {
        const locked = yield* execute(
          "TaskRepo.recordPrState",
          tx.select().from(task).where(scopedTo(input)).limit(ONE).for("update")
        );

        const before = yield* firstRow({
          entity: ENTITY,
          id: input.id,
          rows: locked,
        });

        const current = yield* decodeTaskRow(before);
        if (current.prUrl !== input.prUrl || current.prState === input.state) {
          return yield* Effect.fail(new NothingToRecord());
        }

        const rows = yield* execute(
          "TaskRepo.recordPrState",
          tx.update(task).set(values).where(scopedTo(input)).returning()
        );

        const updated = yield* decodeWritten({
          decode: decodeTaskRow,
          entity: ENTITY,
          operation: "TaskRepo.recordPrState",
          rows,
        });

        return audited(
          true,
          auditUpdate({
            changes: changesOf({ after: values, before }),
            entityId: updated.id,
            entityType: ENTITY,
            taskId: updated.id,
            workspaceId: updated.workspaceId,
          })
        );
      })
    ).pipe(
      // Both are "the world moved on", and the transaction rolled back either
      // way, so both are the same `false` to a caller that is only deciding
      // whether to re-render.
      Effect.catchTags({
        "Db.NotFound": () => Effect.succeed(false),
        "TaskRepo.NothingToRecord": () => Effect.succeed(false),
      })
    );
  });

  return { prCache, recordPrState } as const;
};
