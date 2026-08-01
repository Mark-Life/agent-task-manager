import type {
  ActorKind,
  AgentSessionId,
  AuditAction,
  AuditEntityType,
  AuditEntryId,
  RunId,
  TaskId,
  TaskStatus,
  UserId,
} from "@workspace/domain";
import { index, jsonb, pgTable, text, uuid } from "drizzle-orm/pg-core";
import { baseColumns } from "./columns";

/**
 * Who changed what, written in the same transaction as the mutation it
 * describes so a repository cannot skip it. Three writers share this database
 * and two of them are agents, which is what makes the actor on every mutation
 * mandatory rather than nice to have.
 *
 * Nothing here has a foreign key except the workspace, on purpose: the log must
 * outlive the row it describes, so deleting a task erases the task and leaves
 * its history standing. `task_id` is denormalized for the same reason it exists
 * on run events — a task's activity feed should be one index scan.
 *
 * Transitions get their own two columns rather than being dug out of `changes`,
 * because "how did this task move through the columns" is a question asked
 * often enough to index.
 *
 * Append-only, enforced by revoked privileges rather than by the absence of an
 * `updated_at` column.
 */
export const auditEntry = pgTable(
  "audit_entry",
  {
    ...baseColumns<AuditEntryId>(),
    action: text("action").$type<AuditAction>().notNull(),
    actorKind: text("actor_kind").$type<ActorKind>().notNull(),
    actorRunId: uuid("actor_run_id").$type<RunId>(),
    actorSessionId: uuid("actor_session_id").$type<AgentSessionId>(),
    // Which manager chat thread caused this. No foreign key: the thread table
    // does not exist yet, and the trail is worth having before it does.
    actorThreadId: text("actor_thread_id"),
    actorUserId: text("actor_user_id").$type<UserId>(),
    // `field -> { from, to }` for everything that is not a status move.
    changes: jsonb("changes").notNull().default({}),
    entityId: uuid("entity_id").notNull(),
    entityType: text("entity_type").$type<AuditEntityType>().notNull(),
    fromStatus: text("from_status").$type<TaskStatus>(),
    taskId: uuid("task_id").$type<TaskId>(),
    toStatus: text("to_status").$type<TaskStatus>(),
    // Joins the mutation to the request or run that caused it.
    traceId: text("trace_id"),
  },
  (t) => [
    // `entity_id` is a globally unique uuidv7, so leading with `entity_type`
    // would buy nothing.
    index("audit_entry_entity_id_created_at_idx").on(
      t.entityId,
      t.createdAt.desc()
    ),
    index("audit_entry_task_id_created_at_idx").on(
      t.taskId,
      t.createdAt.desc()
    ),
    index("audit_entry_workspace_id_created_at_idx").on(
      t.workspaceId,
      t.createdAt.desc()
    ),
  ]
);
