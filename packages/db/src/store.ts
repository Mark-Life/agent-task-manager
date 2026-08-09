import { Layer } from "effect";
import { type DatabaseOptions, databaseLayer } from "./client";
import { ArtifactRepo } from "./repositories/artifact";
import { AuditLogRepo } from "./repositories/audit-log";
import { ChatMessageRepo } from "./repositories/chat-message";
import { ChatNotificationRepo } from "./repositories/chat-notification";
import { ChatThreadRepo } from "./repositories/chat-thread";
import { ProjectRepo } from "./repositories/project";
import { ProjectEnvFileRepo } from "./repositories/project-env";
import { RunRepo } from "./repositories/run";
import { RunCommandRepo } from "./repositories/run-command";
import { RunEventRepo } from "./repositories/run-event";
import { AgentSessionRepo } from "./repositories/session";
import { AgentSessionUsageRepo } from "./repositories/session-usage";
import { TaskRepo } from "./repositories/task";
import { TaskMessageRepo } from "./repositories/task-message";
import { WorkspaceRepo } from "./repositories/workspace";

/**
 * Every repository, over whatever database handle is already in context.
 *
 * They merge rather than stack because no repository calls another: one
 * aggregate each, and anything spanning two of them is the caller's
 * composition. That is also what keeps a mutation and its audit row inside a
 * single transaction — there is no second repository underneath to open one of
 * its own.
 *
 * One of them needs more than a handle: `ProjectEnvFileRepo` derives its
 * sealing key from `BETTER_AUTH_SECRET` while this layer is built, so a process
 * that provides the store without that variable refuses to start rather than
 * discovering it on the first dispatch that has a file to write.
 */
export const repositoriesLayer = Layer.mergeAll(
  AgentSessionRepo.layer,
  AgentSessionUsageRepo.layer,
  ArtifactRepo.layer,
  AuditLogRepo.layer,
  ChatMessageRepo.layer,
  ChatNotificationRepo.layer,
  ChatThreadRepo.layer,
  TaskMessageRepo.layer,
  ProjectEnvFileRepo.layer,
  ProjectRepo.layer,
  RunCommandRepo.layer,
  RunEventRepo.layer,
  RunRepo.layer,
  TaskRepo.layer,
  WorkspaceRepo.layer
);

/**
 * The whole store for one process: every repository over one connection pool.
 * Provide it once at a composition root, and give it an actor — the
 * repositories carry `CurrentActor` as a requirement, so a process that never
 * says who it is cannot call a mutation.
 *
 * The database layer is merged in rather than hidden because two of the things
 * it builds are legitimately used above this line: the auth handle Better Auth
 * is constructed with, and the `PgClient` the event stream and the dispatch
 * trigger listen on. The drizzle handle itself stays unexported, so the only
 * way to a row is through a repository that audits what it did.
 */
export const storeLayer = (options: DatabaseOptions) =>
  repositoriesLayer.pipe(Layer.provideMerge(databaseLayer(options)));

/**
 * The store for the bot: the three chat tables it owns, and read access to what
 * it has to render — a run's ending, its task, its events, the audit row naming
 * the conversation that asked for it.
 *
 * What is missing is the point. The chat repositories need no actor, because a
 * conversation is not audited; the last four do, because their mutations are,
 * and a process that never provides `CurrentActor` cannot call one. So the rule
 * that the bot owns the conversation and the gateway owns the board is a
 * compile error rather than a convention: a board write from the bot names the
 * missing service instead of quietly landing without an author.
 */
export const chatStoreLayer = (options: DatabaseOptions) =>
  Layer.mergeAll(
    AuditLogRepo.layer,
    ChatMessageRepo.layer,
    ChatNotificationRepo.layer,
    ChatThreadRepo.layer,
    RunEventRepo.layer,
    RunRepo.layer,
    TaskRepo.layer
  ).pipe(Layer.provideMerge(databaseLayer(options)));
