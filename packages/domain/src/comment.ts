import { Schema } from "effect";
import { CommentAuthorKind, CommentKind } from "./enums";
import { AgentSessionId, CommentId, RunId, TaskId, UserId } from "./ids";
import { recordFields } from "./primitives";

/**
 * The task's conversation, and the only channel that crosses sessions. Append
 * only: no edit and no delete, which is why there is no `editedAt`. Transcripts
 * are the full record of what happened; this is the short deliberate thing the
 * next reader needs.
 *
 * Attribution is what makes several sessions on one task readable — the UI can
 * say "from the review session" instead of presenting one undifferentiated
 * voice — so the author, its session and its run are all columns.
 */
export const Comment = Schema.Struct({
  ...recordFields,
  /** Which session spoke. */
  agentSessionId: Schema.NullOr(AgentSessionId),
  authorKind: CommentAuthorKind,
  /** Set for a human or the manager. No foreign key: attribution outlives accounts. */
  authorUserId: Schema.NullOr(UserId),
  body: Schema.String,
  id: CommentId,
  kind: CommentKind,
  /** Which attempt spoke. */
  runId: Schema.NullOr(RunId),
  /** The thread belongs to the task, not to the session that happened to write in it. */
  taskId: TaskId,
});

export interface Comment extends Schema.Schema.Type<typeof Comment> {}
