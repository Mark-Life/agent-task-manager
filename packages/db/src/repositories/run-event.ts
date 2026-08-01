/**
 * A run's normalized event stream: the live feed, the replay source and the
 * record of what an agent did, all one append-only table.
 *
 * Nothing here clips text. The transcript ingest owns that — it is the only
 * writer that knows which field of a payload is safe to cut and what the full
 * text was, and the domain's text budgets are the numbers it clips to. This
 * repository refuses a payload already over the budget rather than silently
 * shortening one, because a row quietly shorter than what the run said is worse
 * than an ingest that has to answer for its own truncation.
 */

import type {
  RunEventId,
  RunId,
  TaskId,
  Timestamp,
  WorkspaceId,
} from "@workspace/domain";
import {
  newRunEventId,
  RUN_EVENT_PAYLOAD_BUDGET_BYTES,
  RunEventKind,
  RunEventPayload,
  splitPayload,
} from "@workspace/domain";
import { and, asc, eq, gt } from "drizzle-orm";
import { Context, Effect, Layer, Schema } from "effect";
import { Database } from "../client";
import { decodeRunEvent, JsonObject, RunEventInsert } from "../rows";
import { runEvent } from "../schema/run";
import {
  decodeMany,
  decodeWritten,
  encodeWrite,
  execute,
  InvalidInput,
} from "./audit";

/** A conflict on `(run_id, seq)` is resolved by reading the one row already there. */
const ONE = 1;

/**
 * How many events a single read returns unless told otherwise. A run's timeline
 * is unbounded, and a dashboard asking for all of it would pull a transcript's
 * worth of rows into memory; the caller pages with the cursor instead.
 */
const DEFAULT_LIMIT = 500;

/** The table these rows live in, and what an error names them as. */
const ENTITY = "run_event";

const encoder = new TextEncoder();

const encodePayload = Schema.encodeEffect(RunEventPayload);
const asBlob = Schema.decodeUnknownEffect(JsonObject);

/** One line of one run's event file. */
interface EventRef {
  readonly runId: RunId;
  readonly seq: number;
  readonly workspaceId: WorkspaceId;
}

/** What an ingest hands over per line. Both clocks are kept; this one is the harness's. */
interface AppendInput extends EventRef {
  readonly occurredAt: Timestamp;
  readonly payload: RunEventPayload;
  /** Denormalized, so an SSE subscriber filters one task's stream without a join. */
  readonly taskId: TaskId;
}

/**
 * A payload that would not fit. The database has a ceiling of its own, so that a
 * chatty run cannot put megabytes into the write-ahead log and every backup
 * forever; this is the same refusal arriving before the insert, from under that
 * ceiling, naming the event that caused it.
 *
 * Clipping the text down to its budget is the ingest's job and not this one's:
 * the full text is in the transcript on disk, and only the writer knows which
 * field is safe to cut.
 */
export class RunEventTooLarge extends Schema.TaggedErrorClass<RunEventTooLarge>()(
  "RunEventRepo.TooLarge",
  { bytes: Schema.Number, kind: RunEventKind, limit: Schema.Number }
) {}

/**
 * Splits a payload into the column that holds its tag and the blob that never
 * repeats it, and refuses one that is over the budget.
 *
 * The size is measured on the JSON text, while the database sizes the stored
 * `jsonb` — a different representation that can be the larger of the two. The
 * budget sits below the database's ceiling by enough to cover the difference,
 * which is what makes this refusal a real bound on that one rather than a guess
 * that happens to agree with it.
 */
const columnsOf = (payload: RunEventPayload) =>
  Effect.gen(function* () {
    const encoded = yield* Effect.mapError(
      encodePayload(payload),
      (cause) => new InvalidInput({ cause, entity: ENTITY })
    );
    // The tag is named explicitly because the split is generic over any tagged
    // payload: without it the discriminator comes back as a bare string and the
    // column would take one.
    const { kind, payload: rest } = splitPayload<RunEventKind, typeof encoded>(
      encoded
    );
    const blob = yield* Effect.mapError(
      asBlob(rest),
      (cause) => new InvalidInput({ cause, entity: ENTITY })
    );
    const bytes = encoder.encode(JSON.stringify(blob)).length;
    if (bytes >= RUN_EVENT_PAYLOAD_BUDGET_BYTES) {
      return yield* Effect.fail(
        new RunEventTooLarge({
          bytes,
          kind,
          limit: RUN_EVENT_PAYLOAD_BUDGET_BYTES,
        })
      );
    }
    return { kind, payload: blob };
  });

const valuesOf = (input: AppendInput) =>
  Effect.gen(function* () {
    const columns = yield* columnsOf(input.payload);
    return yield* encodeWrite({
      entity: ENTITY,
      schema: RunEventInsert,
      value: {
        id: newRunEventId(),
        kind: columns.kind,
        occurredAt: input.occurredAt,
        payload: columns.payload,
        runId: input.runId,
        seq: input.seq,
        taskId: input.taskId,
        workspaceId: input.workspaceId,
      },
    });
  });

const make = Effect.gen(function* () {
  const db = yield* Database;

  /**
   * Appends one event. The insert is the whole mechanism: a trigger on this table
   * fires the notify the gateway's event stream rides on, so nothing else has to
   * remember to publish.
   *
   * `seq` is the line ordinal in the container's event file rather than a
   * counter, so re-ingesting the same file collides on `(runId, seq)` by
   * construction. The collision is the point — the row already there is returned
   * unchanged, and a second ingest is a no-op instead of a duplicated timeline.
   *
   * No audit row and no actor: this table is the record of what an agent did, and
   * auditing an audit is a loop with nothing at the end of it.
   */
  const append = Effect.fn("RunEventRepo.append")(function* (
    input: AppendInput
  ) {
    yield* Effect.annotateCurrentSpan({
      runId: input.runId,
      taskId: input.taskId,
    });
    const values = yield* valuesOf(input);
    const written = yield* execute(
      "RunEventRepo.append",
      db
        .insert(runEvent)
        .values(values)
        .onConflictDoNothing({ target: [runEvent.runId, runEvent.seq] })
        .returning()
    );
    const inserted = yield* decodeMany({
      decode: decodeRunEvent,
      entity: ENTITY,
      rows: written,
    });
    const [fresh] = inserted;
    if (fresh !== undefined) {
      return fresh;
    }
    const existing = yield* execute(
      "RunEventRepo.append",
      db
        .select()
        .from(runEvent)
        .where(
          and(
            eq(runEvent.workspaceId, input.workspaceId),
            eq(runEvent.runId, input.runId),
            eq(runEvent.seq, input.seq)
          )
        )
        .limit(ONE)
    );
    return yield* decodeWritten({
      decode: decodeRunEvent,
      entity: ENTITY,
      operation: "RunEventRepo.append",
      rows: existing,
    });
  });

  /**
   * Appends a whole file's worth of events in one statement, skipping the lines
   * already stored. Returns what was actually new, so re-ingesting an unchanged
   * file returns nothing and re-ingesting a partial one returns only its tail.
   */
  const appendAll = Effect.fn("RunEventRepo.appendAll")(function* (
    inputs: readonly AppendInput[]
  ) {
    if (inputs.length === 0) {
      return [];
    }
    const values = yield* Effect.forEach(inputs, valuesOf);
    const written = yield* execute(
      "RunEventRepo.appendAll",
      db
        .insert(runEvent)
        .values(values)
        .onConflictDoNothing({ target: [runEvent.runId, runEvent.seq] })
        .returning()
    );
    return yield* decodeMany({
      decode: decodeRunEvent,
      entity: ENTITY,
      rows: written,
    });
  });

  /**
   * A run's events in the order they happened, which is the order the dashboard
   * replays them in. `afterSeq` is the cursor a stream catches up from before it
   * starts listening.
   */
  const listByRun = Effect.fn("RunEventRepo.listByRun")(function* (input: {
    readonly afterSeq?: number;
    readonly limit?: number;
    readonly runId: RunId;
    readonly workspaceId: WorkspaceId;
  }) {
    yield* Effect.annotateCurrentSpan({ runId: input.runId });
    const rows = yield* execute(
      "RunEventRepo.listByRun",
      db
        .select()
        .from(runEvent)
        .where(
          and(
            eq(runEvent.workspaceId, input.workspaceId),
            eq(runEvent.runId, input.runId),
            input.afterSeq === undefined
              ? undefined
              : gt(runEvent.seq, input.afterSeq)
          )
        )
        .orderBy(asc(runEvent.seq))
        .limit(input.limit ?? DEFAULT_LIMIT)
    );
    return yield* decodeMany({
      decode: decodeRunEvent,
      entity: ENTITY,
      rows,
    });
  });

  /**
   * A task's events across every run on it, oldest first. The cursor is the event
   * id rather than `seq`, because `seq` restarts with each run and an id is a
   * time-ordered uuid that does not.
   */
  const listByTask = Effect.fn("RunEventRepo.listByTask")(function* (input: {
    readonly afterId?: RunEventId;
    readonly limit?: number;
    readonly taskId: TaskId;
    readonly workspaceId: WorkspaceId;
  }) {
    yield* Effect.annotateCurrentSpan({ taskId: input.taskId });
    const rows = yield* execute(
      "RunEventRepo.listByTask",
      db
        .select()
        .from(runEvent)
        .where(
          and(
            eq(runEvent.workspaceId, input.workspaceId),
            eq(runEvent.taskId, input.taskId),
            input.afterId === undefined
              ? undefined
              : gt(runEvent.id, input.afterId)
          )
        )
        .orderBy(asc(runEvent.id))
        .limit(input.limit ?? DEFAULT_LIMIT)
    );
    return yield* decodeMany({
      decode: decodeRunEvent,
      entity: ENTITY,
      rows,
    });
  });

  return { append, appendAll, listByRun, listByTask } as const;
});

/**
 * The live stream, the replay source and a run's own record, all one append-only
 * table. Nothing here updates or deletes: the first migration revokes both, so
 * append-only is a permission rather than a habit.
 */
export class RunEventRepo extends Context.Service<
  RunEventRepo,
  Effect.Success<typeof make>
>()("@workspace/db/RunEventRepo") {
  static readonly layer = Layer.effect(RunEventRepo, make);
}
