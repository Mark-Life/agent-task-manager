/**
 * What this package is, and what it deliberately is not.
 *
 * It is the contract: every operation the system exposes, its request and
 * response shapes, the failures it answers with, and the credential each one
 * needs. Types only — there is not a handler in it, and there must not be. A
 * server implements it group by group and a client derives from the same value,
 * so the two cannot drift; the OpenAPI document falls out of it, which is how
 * everything the backend can do reaches an external agent as tools.
 *
 * The entity schemas are the domain's, annotated with a name so the generated
 * document carries one component per entity instead of the same object inlined
 * at every operation. The request shapes are picks off those, so a field the
 * store calls nullable is nullable here by construction rather than by
 * agreement.
 */

export { Api, makeOpenApiSpec } from "./api";
export {
  AgentSessionEnded,
  ArtifactAlreadyPromoted,
  Forbidden,
  IllegalDeletion,
  IllegalInitialStatus,
  IllegalTransition,
  InvalidInput,
  NotFound,
  PayloadTooLarge,
  ProposalAlreadyDecided,
  RunAlreadyLive,
  RunNotLive,
  TooManyRequests,
  Unauthorized,
} from "./errors";
export { ArtifactsGroup } from "./groups/artifacts";
export { FilesGroup } from "./groups/files";
export { HealthGroup } from "./groups/health";
export { MessagesGroup } from "./groups/messages";
export { ProjectsGroup } from "./groups/projects";
export { ProposalsGroup } from "./groups/proposals";
export { RunCommandsGroup } from "./groups/run-commands";
export { RunsGroup } from "./groups/runs";
export { SessionsGroup } from "./groups/sessions";
export { SkillsGroup } from "./groups/skills";
export { TasksGroup } from "./groups/tasks";
export { ThreadsGroup } from "./groups/threads";
export { UsageGroup } from "./groups/usage";
export {
  Artifact,
  ArtifactPromotion,
  ArtifactUpload,
  PROMOTION_SCOPES,
  PromotionScope,
} from "./schemas/artifact";
export {
  FILE_ENCODINGS,
  FILE_ENTRY_KINDS,
  FileContent,
  FileDirectoryCreate,
  FileEncoding,
  FileEntry,
  FileEntryKind,
  FileMove,
  FileWrite,
  MAX_FILE_BYTES,
} from "./schemas/file";
export { HealthStatus } from "./schemas/health";
export { Project, ProjectCreate, ProjectPatch } from "./schemas/project";
export {
  ProjectEnvFile,
  ProjectEnvFileContent,
  ProjectEnvFileSave,
} from "./schemas/project-env";
export { Proposal } from "./schemas/proposal";
export {
  DEFAULT_EVENT_PAGE,
  Run,
  RunEvent,
  RunEventCursor,
  RunEventPage,
} from "./schemas/run";
export {
  RunCommand,
  RunTarget,
  StartSessionRequest,
} from "./schemas/run-command";
export {
  AgentSession,
  AgentSessionUsage,
  TRANSCRIPT_ROLES,
  Transcript,
  TranscriptEntry,
  TranscriptRole,
  TranscriptUsage,
} from "./schemas/session";
export {
  InstalledSkill,
  SkillFileChange,
  SkillInstall,
  SkillUpdate,
  SkillUpdateApply,
} from "./schemas/skill";
export {
  BoardColumn,
  NextSession,
  Task,
  TaskCreate,
  TaskDetail,
  TaskPatch,
  TaskPlacement,
  TaskTransition,
} from "./schemas/task";
export { TaskMessage, TaskMessagePost } from "./schemas/task-message";
export {
  DEFAULT_MESSAGE_PAGE,
  DEFAULT_THREAD_PAGE,
  Thread,
  ThreadCreate,
  ThreadDetail,
  ThreadMessage,
  ThreadMessageAppend,
  ThreadMessageCursor,
  ThreadMessagePage,
  ThreadMessagePosted,
  ThreadPatch,
} from "./schemas/thread";
export { ProviderUsageSnapshot } from "./schemas/usage";
export {
  AdminAccess,
  AdminToken,
  API_KEY_HEADER,
  API_SCOPES,
  ApiKeyMetadata,
  ApiScope,
  boundTaskId,
  Principal,
  type PrincipalShape,
  ReadAccess,
  ReadToken,
  SessionCookie,
  scopeReaches,
  TaskWriteAccess,
  TaskWriteToken,
  UserApiKey,
} from "./security";
