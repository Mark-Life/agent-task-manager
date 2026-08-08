import { Schema } from "effect";
import { TaskMessageAuthorKind, TaskMessageKind } from "./enums";
import { AgentSessionId, RunId, TaskId, TaskMessageId, UserId } from "./ids";
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
 *
 * The row lives in a table called `comment`, which is what this was called
 * everywhere until the name became part of the contract an external agent is
 * handed. The rename stops at the row layer: `packages/db` maps the table to
 * this entity, and nothing above it says comment.
 */
export const TaskMessage = Schema.Struct({
  ...recordFields,
  /** Which session spoke. */
  agentSessionId: Schema.NullOr(AgentSessionId),
  authorKind: TaskMessageAuthorKind,
  /** Set for a human or the manager. No foreign key: attribution outlives accounts. */
  authorUserId: Schema.NullOr(UserId),
  body: Schema.String,
  id: TaskMessageId,
  kind: TaskMessageKind,
  /** Which attempt spoke. */
  runId: Schema.NullOr(RunId),
  /** The thread belongs to the task, not to the session that happened to write in it. */
  taskId: TaskId,
});

export interface TaskMessage extends Schema.Schema.Type<typeof TaskMessage> {}
