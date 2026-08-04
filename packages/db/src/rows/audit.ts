import {
  ActorKind,
  AgentSessionId,
  AuditAction,
  AuditChanges,
  AuditEntityType,
  AuditEntryId,
  RunId,
  TaskId,
  TaskStatus,
  Timestamp,
  UserId,
  Uuid,
  WorkspaceId,
} from "@workspace/domain";
import {
  createInsertSchema,
  createSelectSchema,
} from "drizzle-orm/effect-schema";
import { Schema } from "effect";
import { auditEntry } from "../schema/audit";

/**
 * `entity_id` is refined to a bare uuid and to no brand at all: which entity a
 * row is about is the column beside it, and branding it as one of them would be
 * a claim the log deliberately does not make — it outlives the row it
 * describes, including a task that no longer exists.
 *
 * `changes` is `jsonb`, so `field -> { from, to }` is only true of a stored row
 * once it has been decoded through the domain schema.
 */
const columns = {
  action: () => AuditAction,
  actorKind: () => ActorKind,
  actorRunId: () => RunId,
  actorSessionId: () => AgentSessionId,
  actorUserId: () => UserId,
  changes: () => AuditChanges,
  entityId: () => Uuid,
  entityType: () => AuditEntityType,
  fromStatus: () => TaskStatus,
  id: () => AuditEntryId,
  taskId: () => TaskId,
  toStatus: () => TaskStatus,
  workspaceId: () => WorkspaceId,
};

/** An `audit_entry` row as the database hands it back. */
export const AuditEntryRow = createSelectSchema(auditEntry, {
  ...columns,
  createdAt: () => Timestamp,
});

/**
 * What a repository writes beside the mutation it describes, in the same
 * transaction, so a write cannot skip it.
 *
 * There is no update schema: the table is append-only, enforced by revoked
 * privileges. A log that can be rewritten is not a log.
 */
export const AuditEntryInsert = createInsertSchema(auditEntry, columns);

/** Turns a raw row into the domain entity. */
export const decodeAuditEntry = Schema.decodeUnknownEffect(AuditEntryRow);
