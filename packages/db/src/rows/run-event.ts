import {
  RunEventId,
  RunEventKind,
  RunEventPayload,
  RunId,
  TaskId,
  Timestamp,
  WorkspaceId,
} from "@workspace/domain";
import {
  createInsertSchema,
  createSelectSchema,
} from "drizzle-orm/effect-schema";
import { Effect, Schema } from "effect";
import { runEvent } from "../schema/run";
import { asEntity } from "./conformance";
import { JsonObject, joinPayload } from "./payload";

/**
 * The discriminator is a column and the blob never repeats it, so `kind` is
 * refined to the literal union and `payload` only as far as "an object". The
 * per-kind shape cannot be checked here — it depends on the column beside it —
 * which is what the decode below is for.
 */
const columns = {
  id: () => RunEventId,
  kind: () => RunEventKind,
  occurredAt: () => Timestamp,
  payload: () => JsonObject,
  runId: () => RunId,
  seq: () => Schema.Natural,
  taskId: () => TaskId,
  workspaceId: () => WorkspaceId,
};

/**
 * A `run_event` row as the database hands it back — storage shape, with the tag
 * still split out of its payload.
 */
export const RunEventRow = createSelectSchema(runEvent, {
  ...columns,
  createdAt: () => Timestamp,
});

/**
 * What an ingest writes. `seq` is the line ordinal of the event in the
 * container's file rather than a counter, so re-ingesting the same file
 * collides on `(run_id, seq)` and the insert is idempotent by construction.
 *
 * There is no update schema: the table is append-only, enforced by revoked
 * privileges rather than by convention.
 */
export const RunEventInsert = createInsertSchema(runEvent, columns);

const decodeRow = Schema.decodeUnknownEffect(RunEventRow);
const decodePayload = Schema.decodeUnknownEffect(RunEventPayload);

/**
 * Turns a raw row into the domain entity, rejoining the `kind` column with its
 * blob and decoding the pair as the tagged union.
 *
 * This is the decode that makes the storage honest. A `jsonb` column carries no
 * shape, so the only thing standing between an agent's malformed usage event
 * and a `RunEventPayload` in the domain is this call — and it validates rather
 * than asserts, so the bad row fails here instead of somewhere that reads
 * `costUsd` off it.
 */
export const decodeRunEvent = (row: unknown) =>
  Effect.gen(function* () {
    const { kind, payload, ...rest } = yield* decodeRow(row);
    const decoded = yield* decodePayload(joinPayload(kind, payload));
    return asEntity({ ...rest, payload: decoded });
  });
