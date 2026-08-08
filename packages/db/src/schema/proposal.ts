import type {
  ProjectId,
  ProposalId,
  ProposalPath,
  ProposalScope,
  ProposalState,
  RunId,
  TaskId,
  UserId,
} from "@workspace/domain";
import { PROPOSAL_BODY_MAX_BYTES } from "@workspace/domain";
import { sql } from "drizzle-orm";
import {
  check,
  foreignKey,
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
 * A change a run asked for in a directory it could not write, and the answer it
 * got.
 *
 * The one table here that stores a document rather than an index of one, and
 * the exception is the point: the file the run wrote sits in a folder later
 * runs on the same task can rewrite, so a confirm that read the disk again
 * would let a run change the bytes between the moment a person read them and
 * the moment they accepted. The body is copied in at collection and is what
 * gets written. `pg_column_size` bounds it, exactly as on `run_event`, so a run
 * that proposes its whole checkout is refused by the table rather than by a
 * backup that quietly got slower.
 *
 * `content_hash` makes collection idempotent. A proposal file is not deleted
 * once it is read — it stays as evidence, and the artifact scan indexes it — so
 * a rerun of the same task meets it again. Keyed on `(task, source_path,
 * content_hash)`, an unchanged file collides and writes nothing, while an
 * edited one is a new request that deserves its own answer.
 *
 * A decision is recorded and a row is never rewritten into a different
 * proposal: `state` leaves `pending` once, and the check below keeps the stamp
 * and the state saying the same thing. What actually landed on disk is in the
 * target scope's own git history, which is the audit trail — there is no second
 * one here.
 */
export const proposal = pgTable(
  "proposal",
  {
    ...mutableColumns<ProposalId>(),
    body: text("body").notNull(),
    contentHash: text("content_hash").notNull(),
    decidedAt: tstz("decided_at"),
    // A user id rather than a flattened actor: the routes that decide are
    // admin-scoped, and an agent's credential can never be issued at that
    // scope, so there is no other kind of decider for the column to hold.
    decidedBy: text("decided_by").$type<UserId>(),
    // Relative to the target scope's root, and validated by `ProposalPath` in
    // the domain before it can reach here — the column is where it goes, not
    // the guard.
    path: text("path").$type<ProposalPath>().notNull(),
    projectId: uuid("project_id").$type<ProjectId>(),
    // Provenance. `set null` rather than cascade: the request outlives the
    // attempt that raised it, and a person still has to answer it.
    runId: uuid("run_id")
      .$type<RunId>()
      .references(() => run.id, { onDelete: "set null" }),
    scope: text("scope").$type<ProposalScope>().notNull(),
    sourcePath: text("source_path").notNull(),
    state: text("state").$type<ProposalState>().notNull().default("pending"),
    taskId: uuid("task_id").$type<TaskId>().notNull(),
  },
  (t) => [
    foreignKey({
      columns: [t.workspaceId, t.taskId],
      foreignColumns: [task.workspaceId, task.id],
      name: "proposal_task_fk",
    }).onDelete("cascade"),
    foreignKey({
      columns: [t.workspaceId, t.projectId],
      foreignColumns: [project.workspaceId, project.id],
      name: "proposal_project_fk",
    }).onDelete("cascade"),
    // The scope and the project are one fact, so the row refuses to hold them
    // as two: a proposal into a project's directory names the project whose
    // directory it means, and one into the workspace names none.
    check(
      "proposal_scope_ck",
      sql`(${t.scope} = 'project') = (${t.projectId} is not null)`
    ),
    // Pending is inert and undecided; decided is answered and stamped. Without
    // this, a row could claim a decision nobody made or hide one somebody did.
    check(
      "proposal_decision_ck",
      sql`(${t.state} = 'pending') = (${t.decidedAt} is null)
        and (${t.decidedAt} is null) = (${t.decidedBy} is null)`
    ),
    // Raw, because a constraint cannot hold a bound parameter.
    check(
      "proposal_body_size_ck",
      sql`pg_column_size(${t.body}) < ${sql.raw(String(PROPOSAL_BODY_MAX_BYTES))}`
    ),
    // What makes re-collection a no-op rather than a second copy of the same
    // request. See the note above.
    uniqueIndex("proposal_task_id_source_path_content_hash_uidx").on(
      t.taskId,
      t.sourcePath,
      t.contentHash
    ),
    // The queue a person works through, and the panel on one task.
    index("proposal_workspace_id_created_at_pending_idx")
      .on(t.workspaceId, t.createdAt)
      .where(sql`${t.state} = 'pending'`),
    index("proposal_task_id_created_at_idx").on(t.taskId, t.createdAt.desc()),
    index("proposal_project_id_idx").on(t.projectId),
    index("proposal_run_id_idx").on(t.runId),
  ]
);
