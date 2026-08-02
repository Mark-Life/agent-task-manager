import {
  ActorKind,
  AgentSessionId,
  RunCommandId,
  RunCommandKind,
  RunCommandPayload,
  RunCommandStatus,
  RunId,
  TaskId,
  ThreadId,
  Timestamp,
  UserId,
  WorkspaceId,
} from "@workspace/domain";
import {
  createInsertSchema,
  createSelectSchema,
  createUpdateSchema,
} from "drizzle-orm/effect-schema";
import { Effect, Schema } from "effect";
import { runCommand } from "../schema/run";
import { asEntity } from "./conformance";
import { JsonObject, joinPayload } from "./payload";

/**
 * Split the same way a run event is: `kind` is the column, the blob holds
 * whatever that kind carries and never the tag.
 *
 * The actor columns are flattened rather than stored as a blob, so "everything
 * this run asked for" and "what did the manager change" stay ordinary indexed
 * queries.
 */
const columns = {
  actorKind: () => ActorKind,
  actorRunId: () => RunId,
  actorSessionId: () => AgentSessionId,
  actorUserId: () => UserId,
  consumedAt: () => Timestamp,
  id: () => RunCommandId,
  kind: () => RunCommandKind,
  payload: () => JsonObject,
  runId: () => RunId,
  status: () => RunCommandStatus,
  taskId: () => TaskId,
  threadId: () => ThreadId,
  workspaceId: () => WorkspaceId,
};

/** A `run_command` row as the database hands it back. */
export const RunCommandRow = createSelectSchema(runCommand, {
  ...columns,
  createdAt: () => Timestamp,
  updatedAt: () => Timestamp,
});

/** What a human, the manager or an agent writes to ask for something. */
export const RunCommandInsert = createInsertSchema(runCommand, columns);

/** What the orchestrator writes back: consumed, or rejected with the reason why. */
export const RunCommandUpdate = createUpdateSchema(runCommand, columns);

const decodeRow = Schema.decodeUnknownEffect(RunCommandRow);
const decodePayload = Schema.decodeUnknownEffect(RunCommandPayload);

/**
 * Turns a raw row into the domain entity, rejoining the `kind` column with its
 * blob and decoding the pair as the tagged union. A `start_session` with no
 * trigger in it fails here, which is the only place it can fail before the
 * orchestrator acts on it.
 */
export const decodeRunCommand = (row: unknown) =>
  Effect.gen(function* () {
    const { kind, payload, ...rest } = yield* decodeRow(row);
    const decoded = yield* decodePayload(joinPayload(kind, payload));
    return asEntity({ ...rest, payload: decoded });
  });
