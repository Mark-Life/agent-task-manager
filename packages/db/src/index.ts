/**
 * What this package lets the rest of the system do, and — more to the point —
 * what it does not.
 *
 * Exported: the repositories, the errors they fail with, the layers that build
 * them, the actor a mutation is performed as, and the built auth instance a
 * server mounts. Every repository takes and returns domain entities, so nothing
 * above this line has to know that Postgres or drizzle exist.
 *
 * Not exported, deliberately: the drizzle tables, the row schemas derived from
 * them, and every database handle — ours and the one Better Auth was built
 * over, which is a handle on all sixteen tables and not only the seven that
 * library manages. A caller holding either could write a row without the audit
 * entry that names who wrote it, which is the one guarantee three kinds of
 * writer sharing one database rest on — so the way to a new query is a new
 * repository method, not an escape hatch. The shared write path — the
 * transaction runner, the audit draft builders, the encode and decode helpers —
 * stays inside for the same reason: it is how a repository is built, not
 * something to build with.
 *
 * The connection pool is hidden too, since a caller holding it could open a
 * connection outside every transaction this package manages. `PgClient` and
 * `SqlClient` are provided by the layer and imported from `@effect/sql-pg` by
 * whoever listens on a channel or writes the raw SQL a migration needs.
 */

export { CurrentActor, withActor } from "./actor";
// `options` is the name the Better Auth schema generator looks for on the
// module it reads; out here it needs one that says which options it holds.
export { options as authOptions } from "./auth/options";
// `Database` is exported as a type and never as a value: a composition root
// that merges the store out has the handle in its layer's type and cannot name
// it otherwise, while a caller still has no way to obtain one and reach a row
// around the repository that audits it.
export type { Database } from "./client";
export { Auth, type DatabaseOptions, databaseLayer } from "./client";
export { type DatabaseConfig, databaseConfig } from "./config";
export {
  ArtifactAlreadyPromoted,
  type ArtifactPromotionInput,
  ArtifactRepo,
  type PromotedArtifacts,
  type PromotionDestination,
} from "./repositories/artifact";
export {
  InvalidInput,
  MalformedRow,
  NotFound,
  PersistenceError,
} from "./repositories/audit";
export { AuditLogRepo } from "./repositories/audit-log";
export {
  type ChatMessageAppend,
  ChatMessageRepo,
  type ThreadMessages,
} from "./repositories/chat-message";
export {
  type ChatNotificationClaim,
  ChatNotificationRepo,
  type NotificationRef,
} from "./repositories/chat-notification";
export {
  type ChatRef,
  type ChatThreadOpen,
  type ChatThreadRef,
  ChatThreadRepo,
  THREAD_TITLE_MAX_CHARS,
} from "./repositories/chat-thread";
export {
  type AgentAuthor,
  type CommentAppend,
  type CommentAuthor,
  CommentRepo,
  type CommentWatermark,
  type HumanAuthor,
  type ManagerAuthor,
  type OrchestratorAuthor,
  type ThreadRef,
} from "./repositories/comment";
export {
  type ProjectCreate,
  type ProjectPatch,
  type ProjectRef,
  ProjectRepo,
} from "./repositories/project";
export {
  RunAlreadyLive,
  RunNotLive,
  RunNotStartable,
  RunRepo,
} from "./repositories/run";
export { RunCommandRepo } from "./repositories/run-command";
export { RunEventRepo, RunEventTooLarge } from "./repositories/run-event";
export { AgentSessionEnded, AgentSessionRepo } from "./repositories/session";
export {
  IllegalInitialStatus,
  IllegalTransition,
  type TaskCreate,
  TaskRepo,
} from "./repositories/task";
export type { TaskBoardView } from "./repositories/task-board";
export type { TaskPatch, TaskRef } from "./repositories/task-edit";
export { WorkspaceRepo } from "./repositories/workspace";
export { chatStoreLayer, repositoriesLayer, storeLayer } from "./store";
