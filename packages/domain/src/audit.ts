import { Schema } from "effect";
import { auditActorFields } from "./actor";
import { AuditAction, AuditEntityType, TaskStatus } from "./enums";
import { AuditEntryId, TaskId, Uuid } from "./ids";
import { appendOnlyFields } from "./primitives";

/**
 * What changed, field by field. Status moves are columns of their own rather
 * than entries here, because "show me every transition" is a query someone runs
 * constantly and digging it out of a blob is not one.
 */
export const AuditChanges = Schema.Record(
  Schema.String,
  Schema.Struct({ from: Schema.Json, to: Schema.Json })
);
export type AuditChanges = typeof AuditChanges.Type;

/**
 * One recorded mutation, naming who made it. Written inside the same
 * transaction as the mutation it describes, in the repository, so a write
 * cannot skip it — which is the whole reason three different kinds of writer
 * can share one database.
 *
 * Append-only, and enforced by revoked privileges rather than by the absence of
 * an `updatedAt` column.
 */
export const AuditEntry = Schema.Struct({
  ...appendOnlyFields,
  ...auditActorFields,
  action: AuditAction,
  changes: AuditChanges,
  /**
   * No foreign key and no brand: the log must survive the row it describes, and
   * which entity type the id belongs to is the neighbouring column.
   */
  entityId: Uuid,
  entityType: AuditEntityType,
  fromStatus: Schema.NullOr(TaskStatus),
  id: AuditEntryId,
  /** Denormalized, so a task's activity feed is one index scan. */
  taskId: Schema.NullOr(TaskId),
  toStatus: Schema.NullOr(TaskStatus),
  /** Joins the mutation to the request or the run that caused it. */
  traceId: Schema.NullOr(Schema.String),
});

export interface AuditEntry extends Schema.Schema.Type<typeof AuditEntry> {}
