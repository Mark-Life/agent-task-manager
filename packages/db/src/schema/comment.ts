import type {
  AgentSessionId,
  CommentAuthorKind,
  CommentId,
  CommentKind,
  RunId,
  TaskId,
  UserId,
} from "@workspace/domain";
import { sql } from "drizzle-orm";
import {
  check,
  foreignKey,
  index,
  pgTable,
  text,
  uuid,
} from "drizzle-orm/pg-core";
import { agentSession } from "./agent-session";
import { mutableColumns } from "./columns";
import { run } from "./run";
import { task } from "./task";

/**
 * The task's conversation, and the only channel that crosses sessions. Deliberate
 * and short, unlike the transcript, which is captured wholesale — this is where
 * a run says the thing the next reader needs.
 *
 * Append-only by convention: there is no `edited_at` because nothing edits a
 * comment. Attribution is what makes many sessions on one task readable, so an
 * agent comment names both the session that spoke and the attempt it spoke from,
 * and the UI can say "from the review session" instead of presenting one
 * undifferentiated voice.
 *
 * `author_user_id` has no foreign key, here and everywhere else: attribution
 * outlives accounts.
 */
export const comment = pgTable(
  "comment",
  {
    ...mutableColumns<CommentId>(),
    agentSessionId: uuid("agent_session_id")
      .$type<AgentSessionId>()
      .references(() => agentSession.id, { onDelete: "set null" }),
    authorKind: text("author_kind").$type<CommentAuthorKind>().notNull(),
    authorUserId: text("author_user_id").$type<UserId>(),
    body: text("body").notNull(),
    // `fallback` is the auto-appended final message, collapsed by the UI;
    // `run_error` is a crashed run's error text and is never collapsed.
    kind: text("kind").$type<CommentKind>().notNull().default("message"),
    runId: uuid("run_id")
      .$type<RunId>()
      .references(() => run.id, { onDelete: "set null" }),
    taskId: uuid("task_id").$type<TaskId>().notNull(),
  },
  (t) => [
    foreignKey({
      columns: [t.workspaceId, t.taskId],
      foreignColumns: [task.workspaceId, task.id],
      name: "comment_task_fk",
    }).onDelete("cascade"),
    // Attribution is only readable if the author columns agree with the kind:
    // a person or the manager names a user, an agent names the session that
    // spoke, and no row can claim both or neither.
    check(
      "comment_author_user_ck",
      sql`(${t.authorKind} in ('human','manager')) = (${t.authorUserId} is not null)`
    ),
    check(
      "comment_author_session_ck",
      sql`(${t.authorKind} = 'agent') = (${t.agentSessionId} is not null)`
    ),
    // Renders the thread, and answers "comments since this session's watermark"
    // in the same `(created_at, id)` order the watermark is compared in.
    index("comment_task_id_created_at_id_idx").on(t.taskId, t.createdAt, t.id),
    index("comment_agent_session_id_idx").on(t.agentSessionId),
    index("comment_run_id_idx").on(t.runId),
  ]
);
