import {
  AgentSessionId,
  RunId,
  TaskId,
  TaskMessageAuthorKind,
  TaskMessageId,
  TaskMessageKind,
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
 * This file is where the table's name stops. The rows live in `comment`,
 * because renaming a live table buys nothing, and every layer above reads
 * {@link TaskMessageRow} and never hears the older word.
 *
 * The author columns are refined as three independent nullable values rather
 * than as one tagged actor: which combinations are legal is a pair of database
 * CHECKs, and the UI reads them as separate facts — who spoke, from which
 * session, on which attempt.
 */
const columns = {
  agentSessionId: () => AgentSessionId,
  authorKind: () => TaskMessageAuthorKind,
  authorUserId: () => UserId,
  id: () => TaskMessageId,
  kind: () => TaskMessageKind,
  runId: () => RunId,
  taskId: () => TaskId,
  workspaceId: () => WorkspaceId,
};

/** A `comment` row as the database hands it back, as a task message. */
export const TaskMessageRow = createSelectSchema(comment, {
  ...columns,
  createdAt: () => Timestamp,
  updatedAt: () => Timestamp,
});

/** What a repository writes to post a task message. */
export const TaskMessageInsert = createInsertSchema(comment, columns);

/**
 * Present because the table is not append-only in the database — only in
 * practice, since nothing edits a task message, which is why there is no `edited_at`
 * column to maintain. A repository that starts using this is changing that
 * decision deliberately.
 */
export const TaskMessageUpdate = createUpdateSchema(comment, columns);

/** Turns a raw row into the domain entity. */
export const decodeTaskMessage = Schema.decodeUnknownEffect(TaskMessageRow);
