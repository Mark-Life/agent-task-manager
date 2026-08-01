import { Schema } from "effect";
import { SessionProvider, SessionStatus } from "./enums";
import { AgentSessionId, CommentId, TaskId } from "./ids";
import { recordFields, Timestamp } from "./primitives";

/**
 * One agent conversation on a task. A task has many of these over its life —
 * an implementation session, a review session that never saw the code being
 * written, the implementation session resuming with that review as its prompt —
 * so the link is a row rather than a column on the task.
 *
 * Named `agent_session` throughout because Better Auth owns `session` for a
 * browser login; the unqualified word in this codebase means theirs.
 */
export const AgentSession = Schema.Struct({
  ...recordFields,
  /**
   * The last comment this session has seen, compared against `comment` as a
   * `(createdAt, id)` tuple so a same-millisecond tie cannot skip a comment.
   * Advanced at prompt-build time, including past this session's own previous
   * output — otherwise a resumed run reads its own fallback comment as new
   * input.
   */
  commentWatermarkAt: Schema.NullOr(Timestamp),
  commentWatermarkId: Schema.NullOr(CommentId),
  /** When the last run on this session terminated. Whether it can be resumed is `status`, not this. */
  endedAt: Schema.NullOr(Timestamp),
  /** Why a failed session failed, so the list answers it without opening the run. */
  errorMessage: Schema.NullOr(Schema.String),
  id: AgentSessionId,
  provider: SessionProvider,
  /** Unknown until the harness reports it; kept apart from `provider` so the provider can change mid-task. */
  providerSessionId: Schema.NullOr(Schema.String),
  status: SessionStatus,
  taskId: TaskId,
});

export interface AgentSession extends Schema.Schema.Type<typeof AgentSession> {}

/**
 * Whether this session can be picked up again. A cleanly finished session is
 * the normal resume target — "continue the task's latest session" means exactly
 * that — so a set `endedAt` disqualifies nothing. Only a failure does.
 */
export const isResumable = (session: Pick<AgentSession, "status">) =>
  session.status !== "failed";
