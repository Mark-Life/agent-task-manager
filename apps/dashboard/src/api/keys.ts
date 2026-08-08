import type {
  ProjectEnvFileId,
  ProjectId,
  RunId,
  AgentSessionId as SessionId,
  TaskId,
  ThreadId,
} from "@workspace/domain";
import type { ApiClientShape } from "@/api/runtime";

/** The three roots every key hangs off, so a whole area invalidates at once. */
const TASKS = "tasks";
const THREADS = "threads";
const PROJECTS = "projects";

/**
 * The fourth root, and the only one that owns nothing. Remaining allowance is a
 * fact about the machine's provider logins rather than about anything on a
 * board, so nothing hangs off it and nothing invalidates it — it is polled.
 */
const USAGE = "usage";

/**
 * The fifth root: the directories a run walks for its instructions, keyed by
 * the one segment a URL names a scope with rather than by the tagged union it
 * decodes into. An object key would be compared field by field on every
 * invalidation, and two objects naming the same directory would be two caches.
 */
const FILES = "files";

/** The list filters, taken from the client rather than restated beside it. */
type TaskListQuery = Parameters<ApiClientShape["tasks"]["list"]>[0]["query"];
type ThreadListQuery = Parameters<
  ApiClientShape["threads"]["list"]
>[0]["query"];

/**
 * Every cache key the app uses, in one place.
 *
 * The shape is deliberately hierarchical: everything a task owns sits under
 * `[TASKS, taskId, ...]`, so invalidating one task also refreshes its messages,
 * runs, sessions and artifacts, and invalidating `[TASKS]` refreshes the board
 * with it. Keys are `as const` tuples so a typo is a type error rather than a
 * query that silently never matches an invalidation.
 */
export const keys = {
  /** Files a run kept, for one task. */
  artifacts: (taskId: TaskId) => [TASKS, taskId, "artifacts"] as const,

  /** The board, optionally narrowed to one project. */
  board: (projectId: ProjectId | null = null) =>
    [TASKS, "board", projectId] as const,

  /** One project. */
  project: (projectId: ProjectId) => [PROJECTS, projectId] as const,

  /** The files a project keeps, which outlive the tasks that wrote them. */
  projectArtifacts: (projectId: ProjectId) =>
    [PROJECTS, projectId, "artifacts"] as const,

  /** One of a project's environment files, with its text. Fetched only by the editor. */
  projectEnvFile: (projectId: ProjectId, fileId: ProjectEnvFileId) =>
    [PROJECTS, projectId, "env", fileId] as const,

  /** The paths one project injects, without their content. */
  projectEnvFiles: (projectId: ProjectId) =>
    [PROJECTS, projectId, "env"] as const,

  /** Every project in the workspace. */
  projects: () => [PROJECTS] as const,

  /** What a task's runs asked a person to change above their own scope. */
  proposals: (taskId: TaskId) => [TASKS, taskId, "proposals"] as const,

  /** One run of one task. */
  run: (taskId: TaskId, runId: RunId) =>
    [TASKS, taskId, "runs", runId] as const,

  /** A run's event timeline. Paged and polled, so it is its own key. */
  runEvents: (taskId: TaskId, runId: RunId) =>
    [TASKS, taskId, "runs", runId, "events"] as const,

  /** Every run of one task. */
  runs: (taskId: TaskId) => [TASKS, taskId, "runs"] as const,

  /**
   * One scope's whole directory tree, and the prefix everything read out of it
   * hangs off. A write anywhere in a scope creates the directories above it and
   * commits, so this is what an edit invalidates: refreshing one listing would
   * leave the folder that has just appeared missing from the tree.
   */
  scope: (address: string) => [FILES, address] as const,

  /** One file's bytes, read only once somebody opens it. */
  scopeFile: (address: string, path: string) =>
    [FILES, address, "file", path] as const,

  /**
   * One directory of one scope. The root is null rather than the empty string,
   * which is the one path no route accepts.
   */
  scopeListing: (address: string, path: string | null) =>
    [FILES, address, "list", path] as const,

  /**
   * What one scope has installed, which is the lock file checked against the
   * disk. Under the scope so an install — which writes files — refreshes the
   * tree and this list from one invalidation.
   */
  scopeSkills: (address: string) => [FILES, address, "skills"] as const,

  /**
   * What one skill's source holds now, against what is installed. Fetched only
   * while somebody is looking at it: this key is the one read here that leaves
   * the machine for GitHub.
   */
  scopeSkillUpdate: (address: string, name: string) =>
    [FILES, address, "skills", name, "update"] as const,

  /** One agent session. */
  session: (taskId: TaskId, sessionId: SessionId) =>
    [TASKS, taskId, "sessions", sessionId] as const,

  /** Every agent session of one task. */
  sessions: (taskId: TaskId) => [TASKS, taskId, "sessions"] as const,

  /**
   * What each of a task's sessions spent. One key for the whole panel, because
   * the server answers it in one call: a bar per row would otherwise be a
   * request per row.
   */
  sessionsUsage: (taskId: TaskId) =>
    [TASKS, taskId, "sessions", "usage"] as const,

  /** One task's detail, and the prefix of everything that task owns. */
  task: (taskId: TaskId) => [TASKS, taskId] as const,

  /** A task's conversation. */
  taskMessages: (taskId: TaskId) => [TASKS, taskId, "messages"] as const,

  /** The flat task list under whatever filters are in effect. */
  tasks: (query: TaskListQuery = {}) => [TASKS, "list", query] as const,

  /** One conversation with the manager. */
  thread: (threadId: ThreadId) => [THREADS, threadId] as const,

  /** One page-independent list of a chat conversation's messages. */
  threadMessages: (threadId: ThreadId) =>
    [THREADS, threadId, "messages"] as const,

  /** The conversation list under whatever filters are in effect. */
  threads: (query: ThreadListQuery = {}) => [THREADS, "list", query] as const,

  /** What is left in the provider subscriptions, as the loop last read it. */
  usage: () => [USAGE] as const,
} as const;
