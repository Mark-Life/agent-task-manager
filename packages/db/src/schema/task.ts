import type {
  AgentSessionId,
  ProjectId,
  TaskId,
  TaskMetadata,
  TaskStatus,
} from "@workspace/domain";
import { sql } from "drizzle-orm";
import {
  type AnyPgColumn,
  boolean,
  check,
  doublePrecision,
  foreignKey,
  index,
  jsonb,
  pgTable,
  text,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import { agentSession } from "./agent-session";
import { mutableColumns, tstz } from "./columns";
import { project } from "./project";

/**
 * The unit of work, and the row three writers — human, manager agent and worker
 * run — all mutate. Everything the board renders is a real column here;
 * everything an agent invents goes in `metadata`, where it costs no migration
 * and can be promoted to a column once a key proves itself.
 *
 * Which session runs next is a property of the task rather than an argument at
 * dispatch time, which is what lets a dropdown in the dashboard and a sentence
 * to the manager agent end up writing the same two columns. The orchestrator
 * resets them to the default after it claims the task.
 *
 * `status_changed_at` is stored rather than derived: "how long has this sat in
 * this column" is the stall signal, and reconstructing it means scanning the
 * audit log.
 */
export const task = pgTable(
  "task",
  {
    ...mutableColumns<TaskId>(),
    acceptance: text("acceptance"),
    brief: text("brief").notNull().default(""),
    // The trace of the write that last asked this task to run, as a W3C
    // `traceparent`. The board's own dispatch trigger is a status change and
    // writes no `run_command`, so a trace that rode only on commands would
    // reach half the runs; this is the row that causes the other half, and the
    // orchestrator reads it off here — a poll, a notify or a restart later —
    // to open its run inside the request's trace rather than its own.
    dispatchTraceparent: text("dispatch_traceparent"),
    metadata: jsonb("metadata").$type<TaskMetadata>().notNull().default({}),
    nextSessionId: uuid("next_session_id")
      .$type<AgentSessionId>()
      .references((): AnyPgColumn => agentSession.id, { onDelete: "set null" }),
    // Start fresh on the next run rather than resuming. The one selection an id
    // cannot express, which is why it is a column and not a null.
    nextSessionNew: boolean("next_session_new").notNull().default(false),
    parentTaskId: uuid("parent_task_id")
      .$type<TaskId>()
      .references((): AnyPgColumn => task.id, { onDelete: "set null" }),
    // Set when repeated failure trips the retry threshold; the dispatcher skips
    // a parked task, so a failing task stops re-dispatching instead of looping.
    parkedUntil: tstz("parked_until"),
    projectId: uuid("project_id").$type<ProjectId>(),
    prUrl: text("pr_url"),
    // Position in its column, ascending, and therefore position in the dispatch
    // queue. Fractional so that dropping a card between two others is one row
    // write rather than a renumbering of everything below it.
    rank: doublePrecision("rank").notNull(),
    // Overrides the project's repository. Null inherits.
    repoUrl: text("repo_url"),
    sandboxImage: text("sandbox_image"),
    status: text("status").$type<TaskStatus>().notNull().default("ideas"),
    statusChangedAt: tstz("status_changed_at").notNull().defaultNow(),
    title: text("title").notNull(),
  },
  (t) => [
    foreignKey({
      columns: [t.workspaceId, t.projectId],
      foreignColumns: [project.workspaceId, project.id],
      name: "task_project_fk",
    }).onDelete("set null"),
    uniqueIndex("task_workspace_id_id_uidx").on(t.workspaceId, t.id),
    // One board column in the order the board renders it and the dispatcher
    // takes from it: by rank, then by age where two cards were dropped into the
    // same gap at once.
    index("task_workspace_id_status_rank_idx").on(
      t.workspaceId,
      t.status,
      t.rank,
      t.createdAt
    ),
    index("task_workspace_id_project_id_status_idx").on(
      t.workspaceId,
      t.projectId,
      t.status
    ),
    index("task_workspace_id_status_status_changed_at_idx").on(
      t.workspaceId,
      t.status,
      t.statusChangedAt
    ),
    // The two next-session columns are one decision, and the fourth combination
    // — pin this session, but also start a fresh one — has no meaning, so the
    // dispatcher never has to pick a winner between them.
    check(
      "task_next_session_ck",
      sql`not (${t.nextSessionNew} and ${t.nextSessionId} is not null)`
    ),
    index("task_parent_task_id_idx").on(t.parentTaskId),
    // Postgres indexes the referenced side of a foreign key, never the
    // referencing side, and the composite index above leads with workspace_id,
    // so deleting one project would otherwise scan this table under lock.
    index("task_project_id_idx").on(t.projectId),
    index("task_next_session_id_idx").on(t.nextSessionId),
  ]
);
