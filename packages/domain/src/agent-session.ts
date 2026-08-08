import { Schema } from "effect";
import { SessionProvider, SessionStatus } from "./enums";
import { AgentSessionId, TaskId, ThreadId, UnreadWatermarkId } from "./ids";
import { recordFields, Timestamp } from "./primitives";

/**
 * One agent conversation, on a task or on a chat thread. A task has many of
 * these over its life — an implementation session, a review session that never
 * saw the code being written, the implementation session resuming with that
 * review as its prompt — so the link is a row rather than a column on the task.
 * A chat thread has them for the same reason: a session that cannot be resumed
 * is replaced by a new one and the conversation is kept.
 *
 * Named `agent_session` throughout because Better Auth owns `session` for a
 * browser login; the unqualified word in this codebase means theirs.
 */
export const AgentSession = Schema.Struct({
  ...recordFields,
  /** When the last run on this session terminated. Whether it can be resumed is `status`, not this. */
  endedAt: Schema.NullOr(Timestamp),
  /** Why a failed session failed, so the list answers it without opening the run. */
  errorMessage: Schema.NullOr(Schema.String),
  id: AgentSessionId,
  provider: SessionProvider,
  /** Unknown until the harness reports it; kept apart from `provider` so the provider can change mid-task. */
  providerSessionId: Schema.NullOr(Schema.String),
  status: SessionStatus,
  /** Set on a session attached to a task, null on one attached to a thread. */
  taskId: Schema.NullOr(TaskId),
  /** Set on a session attached to a thread, null on one attached to a task. */
  threadId: Schema.NullOr(ThreadId),
  /**
   * The last row this session has been shown, compared as a `(createdAt, id)`
   * tuple so a same-millisecond tie cannot skip one. It is a task message on a
   * session attached to a task and a `chat_message` on one attached to a
   * thread — the same question either way, which is why it is one pair of
   * columns.
   *
   * Advanced at prompt-build time, including past this session's own previous
   * output — otherwise a resumed run reads what it said last time as new input.
   * Null means the session has been shown nothing, so its next prompt is the
   * conversation from the beginning.
   */
  unreadWatermarkAt: Schema.NullOr(Timestamp),
  unreadWatermarkId: Schema.NullOr(UnreadWatermarkId),
});

export interface AgentSession extends Schema.Schema.Type<typeof AgentSession> {}

/**
 * Whether this session can be picked up again. A cleanly finished session is
 * the normal resume target — "continue the task's latest session" means exactly
 * that — so a set `endedAt` disqualifies nothing. Only a failure does.
 */
export const isResumable = (session: Pick<AgentSession, "status">) =>
  session.status !== "failed";
