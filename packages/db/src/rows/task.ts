import {
  AgentSessionId,
  ProjectId,
  TaskId,
  TaskMetadata,
  TaskStatus,
  Timestamp,
  WorkspaceId,
} from "@workspace/domain";
import {
  createInsertSchema,
  createSelectSchema,
  createUpdateSchema,
} from "drizzle-orm/effect-schema";
import { Schema } from "effect";
import { task } from "../schema/task";

/**
 * `metadata` is the one place an agent writes a shape nobody declared, and it
 * is exactly where a cast would be a lie: the column is `jsonb`, so the only
 * thing that makes the domain's `TaskMetadata` true of a stored row is decoding
 * it through that schema on the way out.
 *
 * The two next-session columns are refined individually rather than as a
 * union, because the union lives in the domain and is read off them by
 * `nextSessionOf`. Their consistency is a database CHECK, not a schema.
 */
const columns = {
  id: () => TaskId,
  metadata: () => TaskMetadata,
  nextSessionId: () => AgentSessionId,
  parentTaskId: () => TaskId,
  parkedUntil: () => Timestamp,
  projectId: () => ProjectId,
  status: () => TaskStatus,
  statusChangedAt: () => Timestamp,
  title: () => Schema.NonEmptyString,
  workspaceId: () => WorkspaceId,
};

/** A `task` row as the database hands it back. */
export const TaskRow = createSelectSchema(task, {
  ...columns,
  createdAt: () => Timestamp,
  updatedAt: () => Timestamp,
});

/** What a repository writes to create a task. */
export const TaskInsert = createInsertSchema(task, columns);

/** What a repository may change on a task, including the transition columns. */
export const TaskUpdate = createUpdateSchema(task, columns);

/**
 * Turns a raw row into the domain entity. The status is checked against the
 * literal union here and nowhere else on the read path, so a value the status
 * machine has never heard of is rejected at the boundary instead of reaching a
 * transition lookup that would silently find no legal moves.
 */
export const decodeTask = Schema.decodeUnknownEffect(TaskRow);
