import type {
  AgentSessionId,
  SessionProvider,
  SessionStatus,
  TaskId,
  ThreadId,
  UnreadWatermarkId,
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
import { chatThread } from "./chat";
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
 * stays visible as failed rather than as an absence. A chat thread has them for
 * the same reason and through the same rows: a manager's turn runs inside a
 * session, and a provider switch opens another one instead of erasing
 * anything.
 *
 * The watermark is the last row this session has been shown — a `comment` when
 * it is attached to a task, a `chat_message` when it is attached to a thread.
 * On resume its prompt is everything added since, so neither the cross-session
 * channel nor a conversation's backlog needs special-casing anywhere. Both
 * halves are stored because the comparison is a `(created_at, id)` tuple: a
 * same-millisecond tie must not skip a row. There is deliberately no foreign
 * key on `unread_watermark_id` — it points at one of two tables, and a cascade
 * that nulled the id while leaving the timestamp set would make every tuple
 * comparison NULL, silently feeding a resumed run nothing at all.
 *
 * No agent-home path here or on the run: every run of a provider shares one
 * host directory, so there is nothing per session or per run to record.
 */
export const agentSession = pgTable(
  "agent_session",
  {
    ...mutableColumns<AgentSessionId>(),
    // When the last run on this session terminated; `status` says whether it can
    // still be resumed.
    endedAt: tstz("ended_at"),
    errorMessage: text("error_message"),
    provider: text("provider").$type<SessionProvider>().notNull(),
    // Unknown until the harness reports it, and kept apart from our own id so
    // the provider can change without rewriting the session.
    providerSessionId: text("provider_session_id"),
    status: text("status").$type<SessionStatus>().notNull().default("running"),
    taskId: uuid("task_id").$type<TaskId>(),
    threadId: uuid("thread_id").$type<ThreadId>(),
    unreadWatermarkAt: tstz("unread_watermark_at"),
    unreadWatermarkId: uuid("unread_watermark_id").$type<UnreadWatermarkId>(),
  },
  (t) => [
    foreignKey({
      columns: [t.workspaceId, t.taskId],
      foreignColumns: [task.workspaceId, task.id],
      name: "agent_session_task_fk",
    }).onDelete("cascade"),
    foreignKey({
      columns: [t.workspaceId, t.threadId],
      foreignColumns: [chatThread.workspaceId, chatThread.id],
      name: "agent_session_thread_fk",
    }).onDelete("cascade"),
    // A session belongs to exactly one of the two, which is what makes "the
    // latest session on this thread" a question with one answer.
    check(
      "agent_session_subject_ck",
      sql`(${t.taskId} is null) <> (${t.threadId} is null)`
    ),
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
      sql`(${t.unreadWatermarkId} is null) = (${t.unreadWatermarkAt} is null)`
    ),
    uniqueIndex("agent_session_workspace_id_id_uidx").on(t.workspaceId, t.id),
    // The session list, and "the latest session" that a default resume means.
    index("agent_session_task_id_created_at_idx").on(t.taskId, t.createdAt),
    index("agent_session_thread_id_created_at_idx").on(t.threadId, t.createdAt),
  ]
);
