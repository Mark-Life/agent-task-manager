import {
  AgentSessionId,
  CommentAuthorKind,
  CommentId,
  CommentKind,
  RunId,
  TaskId,
  Timestamp,
  UserId,
  WorkspaceId,
} from "@workspace/domain";
import {
  createInsertSchema,
  createSelectSchema,
  createUpdateSchema,
} from "drizzle-orm/effect-schema";
import { Schema } from "effect";
import { comment } from "../schema/comment";

/**
 * The author columns are refined as three independent nullable values rather
 * than as one tagged actor: which combinations are legal is a pair of database
 * CHECKs, and the UI reads them as separate facts — who spoke, from which
 * session, on which attempt.
 */
const columns = {
  agentSessionId: () => AgentSessionId,
  authorKind: () => CommentAuthorKind,
  authorUserId: () => UserId,
  id: () => CommentId,
  kind: () => CommentKind,
  runId: () => RunId,
  taskId: () => TaskId,
  workspaceId: () => WorkspaceId,
};

/** A `comment` row as the database hands it back. */
export const CommentRow = createSelectSchema(comment, {
  ...columns,
  createdAt: () => Timestamp,
  updatedAt: () => Timestamp,
});

/** What a repository writes to post a comment. */
export const CommentInsert = createInsertSchema(comment, columns);

/**
 * Present because the table is not append-only in the database — only in
 * practice, since nothing edits a comment, which is why there is no `edited_at`
 * column to maintain. A repository that starts using this is changing that
 * decision deliberately.
 */
export const CommentUpdate = createUpdateSchema(comment, columns);

/** Turns a raw row into the domain entity. */
export const decodeComment = Schema.decodeUnknownEffect(CommentRow);
