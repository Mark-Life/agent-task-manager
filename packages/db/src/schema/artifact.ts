import type {
  ArtifactId,
  ArtifactScope,
  ProjectId,
  RunId,
  TaskId,
} from "@workspace/domain";
import { sql } from "drizzle-orm";
import {
  type AnyPgColumn,
  bigint,
  check,
  index,
  pgTable,
  text,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import { mutableColumns, tstz } from "./columns";
import { project } from "./project";
import { run } from "./run";
import { task } from "./task";

/**
 * An index of the files a run kept, never their bytes. The files live on disk,
 * mounted into the container; reading them back out of Postgres would cost a
 * query round trip for something already in the page cache, and large values
 * bloat the write-ahead log and every backup, forever.
 *
 * Because the row is derivable from the directory it describes, this table is a
 * cache rather than a source of truth: if it drifts, rescan. Rescan is an upsert
 * on the per-scope natural key plus a delete of rows whose file is gone, and it
 * writes no audit rows — a cache refresh is not a mutation, and auditing it
 * would bury the mutations the log exists for.
 *
 * Scope decides which key applies. A task-scoped row dies with its task; a
 * promoted or global row carries no task and survives it. `project_id` cascades
 * rather than nulling, because a NULL never conflicts in a unique index, so one
 * `set null` would quietly switch off the `(project_id, path)` upsert key and
 * every later rescan would append duplicates.
 */
export const artifact = pgTable(
  "artifact",
  {
    ...mutableColumns<ArtifactId>(),
    // Number mode, not bigint: the mode is required, file sizes are far inside
    // 2^53, and a BigInt is a value the API cannot serialize.
    bytes: bigint("bytes", { mode: "number" }).notNull(),
    // Written only when a file is promoted or copied, and null everywhere else.
    // A rescan does not hash: size and modified time already say the file
    // changed, and hashing the tree on every run would buy nothing more.
    contentHash: text("content_hash"),
    ext: text("ext"),
    lastRunId: uuid("last_run_id")
      .$type<RunId>()
      .references(() => run.id, { onDelete: "set null" }),
    // From `stat`, not from us.
    modifiedAt: tstz("modified_at").notNull(),
    // Relative to the scope root. The natural key.
    path: text("path").notNull(),
    projectId: uuid("project_id")
      .$type<ProjectId>()
      .references(() => project.id, { onDelete: "cascade" }),
    promotedAt: tstz("promoted_at"),
    scope: text("scope").$type<ArtifactScope>().notNull().default("task"),
    // The row this file was copied from — promotion or cross-project reuse,
    // since reuse is always a copy. Which one it was is the audit action.
    sourceArtifactId: uuid("source_artifact_id")
      .$type<ArtifactId>()
      .references((): AnyPgColumn => artifact.id, { onDelete: "set null" }),
    taskId: uuid("task_id")
      .$type<TaskId>()
      .references(() => task.id, { onDelete: "cascade" }),
  },
  (t) => [
    // Scope decides which upsert key applies, so the owning column has to match
    // it: a task-scoped row that named no task would be invisible to every
    // rescan and would never be deleted with its task.
    check(
      "artifact_task_scope_ck",
      sql`(${t.scope} = 'task') = (${t.taskId} is not null)`
    ),
    check(
      "artifact_project_scope_ck",
      sql`(${t.scope} = 'project') = (${t.projectId} is not null)`
    ),
    uniqueIndex("artifact_task_id_path_uidx")
      .on(t.taskId, t.path)
      .where(sql`${t.scope} = 'task'`),
    uniqueIndex("artifact_project_id_path_uidx")
      .on(t.projectId, t.path)
      .where(sql`${t.scope} = 'project'`),
    uniqueIndex("artifact_workspace_id_path_uidx")
      .on(t.workspaceId, t.path)
      .where(sql`${t.scope} = 'global'`),
    // The artifacts panel.
    index("artifact_task_id_modified_at_idx").on(t.taskId, t.modifiedAt.desc()),
    index("artifact_project_id_idx").on(t.projectId),
    index("artifact_last_run_id_idx").on(t.lastRunId),
    // Also answers "how often was this file copied".
    index("artifact_source_artifact_id_idx").on(t.sourceArtifactId),
  ]
);
