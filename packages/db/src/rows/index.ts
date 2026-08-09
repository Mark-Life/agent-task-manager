/**
 * Row schemas: the seam between what Postgres stores and what the domain means.
 *
 * Every schema here is derived from a drizzle table with `createSelectSchema` /
 * `createInsertSchema` / `createUpdateSchema` rather than written out by hand,
 * so the table stays the single description of the storage shape. A repository
 * decodes a row through one of these and hands back a domain entity; nothing in
 * this folder leaves the package.
 *
 * **What gets refined.** A column is refined with its domain schema when that
 * schema says something the derived one cannot: a brand, a literal set, a
 * check, or a different representation — `timestamptz` read as a `Date` and
 * meant as a zone-aware instant, `jsonb` read as any JSON and meant as one
 * tagged payload. A column whose domain type is plainly `string` or `number` is
 * deliberately left underived, because the derived schema tracks the column: if
 * someone retypes `text` to `integer` the conformance test fails, where a hand
 * written `Schema.String` would have gone on agreeing with the domain and
 * failed at runtime on real data instead.
 *
 * **How it is refined.** Always the function form, `() => DomainSchema`. A bare
 * schema replaces the column outright and takes the `| null` off a nullable
 * column with it, so the row type would still match the entity and the first
 * NULL read would throw. The function form re-wraps.
 *
 * **What is never refined.** `created_at` and `updated_at` are absent from
 * every insert and update: the column default and the `BEFORE UPDATE` trigger
 * own them, and a writer supplying its own clock is the one source of a skew
 * nobody can later explain. Append-only tables — `run_event`, `audit_entry` —
 * have no update schema at all, because the first migration revokes UPDATE on
 * them.
 *
 * The type-level contract holding all of this together is `./conformance`.
 */

export {
  AgentSessionInsert,
  AgentSessionRow,
  AgentSessionUpdate,
  decodeAgentSession,
} from "./agent-session";
export {
  AgentSessionUsageInsert,
  AgentSessionUsageRow,
  decodeAgentSessionUsage,
} from "./agent-session-usage";
export {
  ArtifactInsert,
  ArtifactRow,
  ArtifactUpdate,
  decodeArtifact,
} from "./artifact";
export { AuditEntryInsert, AuditEntryRow, decodeAuditEntry } from "./audit";
export {
  ChatMessageInsert,
  ChatMessageRow,
  ChatNotificationInsert,
  ChatNotificationRow,
  ChatNotificationUpdate,
  ChatThreadInsert,
  ChatThreadRow,
  ChatThreadUpdate,
  decodeChatMessage,
  decodeChatNotification,
  decodeChatThread,
} from "./chat";
export { conforms, type Decoded } from "./conformance";
export { JsonObject, joinPayload } from "./payload";
export {
  decodeProject,
  ProjectInsert,
  ProjectRow,
  ProjectUpdate,
} from "./project";
export {
  decodeProjectEnvFile,
  decodeProjectEnvFileRow,
  ProjectEnvFileInsert,
  ProjectEnvFileRow,
  ProjectEnvFileUpdate,
} from "./project-env";
export { decodeRun, RunInsert, RunRow, RunUpdate } from "./run";
export {
  decodeRunCommand,
  RunCommandInsert,
  RunCommandRow,
  RunCommandUpdate,
} from "./run-command";
export { decodeRunEvent, RunEventInsert, RunEventRow } from "./run-event";
export { decodeTask, TaskInsert, TaskRow, TaskUpdate } from "./task";
export {
  decodeTaskMessage,
  TaskMessageInsert,
  TaskMessageRow,
  TaskMessageUpdate,
} from "./task-message";
export { decodeWorkspace, WorkspaceRow } from "./workspace";
