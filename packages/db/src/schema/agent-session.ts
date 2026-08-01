import type {
  AgentSessionId,
  CommentId,
  SessionProvider,
  SessionStatus,
  TaskId,
} from "@workspace/domain";
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
import { task } from "./task";

/**
 * One agent conversation. Named `agent_session` because the auth library owns
 * the table called `session`, and the word "session" unqualified in this
 * codebase means that one.
 *
 * A task has many of these over its life — an implementation session that wrote
 * the PR, a fresh review session with no memory of having written it, the
 * implementation session resumed with the review as its next prompt. Each
 * carries its own status, so a research session that died producing nothing
 * stays visible as failed rather than as an absence.
 *
 * The watermark is the last comment this session has read. On resume its prompt
 * is every comment added since, so the cross-session channel needs no
 * special-casing anywhere. Both halves are stored because the comparison is a
 * `(created_at, id)` tuple: a same-millisecond tie must not skip a comment.
 * There is deliberately no foreign key on `comment_watermark_id` — a watermark
 * is a position, and a cascade that nulled the id while leaving the timestamp
 * set would make every tuple comparison NULL, silently feeding a resumed run no
 * feedback at all.
 *
 * No agent-home path here: the home directory is per run, because parallel
 * containers sharing one credentials file invalidate each other.
 */
export const agentSession = pgTable(
  "agent_session",
  {
    ...mutableColumns<AgentSessionId>(),
    commentWatermarkAt: tstz("comment_watermark_at"),
    commentWatermarkId: uuid("comment_watermark_id").$type<CommentId>(),
    // When the last run on this session terminated; `status` says whether it can
    // still be resumed.
    endedAt: tstz("ended_at"),
    errorMessage: text("error_message"),
    provider: text("provider").$type<SessionProvider>().notNull(),
    // Unknown until the harness reports it, and kept apart from our own id so
    // the provider can change without rewriting the session.
    providerSessionId: text("provider_session_id"),
    status: text("status").$type<SessionStatus>().notNull().default("running"),
    taskId: uuid("task_id").$type<TaskId>().notNull(),
  },
  (t) => [
    foreignKey({
      columns: [t.workspaceId, t.taskId],
      foreignColumns: [task.workspaceId, task.id],
      name: "agent_session_task_fk",
    }).onDelete("cascade"),
    // Liveness is one fact, so it cannot be written two ways that disagree: a
    // running session has not ended, and a stopped one has.
    check(
      "agent_session_ended_ck",
      sql`(${t.status} = 'running') = (${t.endedAt} is null)`
    ),
    // Half a watermark makes every `(created_at, id)` comparison NULL, which
    // would feed a resumed run no feedback at all rather than failing loudly.
    check(
      "agent_session_watermark_ck",
      sql`(${t.commentWatermarkId} is null) = (${t.commentWatermarkAt} is null)`
    ),
    uniqueIndex("agent_session_workspace_id_id_uidx").on(t.workspaceId, t.id),
    // The session list, and "the latest session" that a default resume means.
    index("agent_session_task_id_created_at_idx").on(t.taskId, t.createdAt),
  ]
);
