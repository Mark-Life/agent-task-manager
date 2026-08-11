/**
 * What this package lets the rest of the system do, and — more to the point —
 * what it does not.
 *
 * The sandbox turns a command and a set of directories into a container that
 * runs it, and leaves one `atm.sandbox` row behind. It has exactly one consumer,
 * the orchestrator, and one hard rule: it never imports `@workspace/db`. There
 * is no database handle inside a container, so everything a run learns travels
 * out as files on a mount, as environment variables, and as events — which is
 * what makes this package extractable, and what makes a run reproducible by hand
 * with a `docker run` a human can read.
 *
 * Exported: the one {@link Sandbox} service and the two layers behind it, the
 * spec a run is described by, the mount set and the container-side paths the
 * harness agrees with, the confinement, the image names, the typed failures, the
 * workspace and repo materialization, the artifact folders with the history the
 * shared ones keep and the instruction budget a tree adds up to, and the event
 * marker a query starts from.
 *
 * **Both implementations sit behind the one service, and the choice is config.**
 * {@link sandboxLayer} reads `SANDBOX_MODE` and builds the docker layer or the
 * local one; nothing above the seam learns which it got, because the moment
 * dispatch can ask, dispatch grows a branch and the escape hatch stops being the
 * same code path. The two named layers are exported anyway, for a script that
 * has to pin one — a check meaning to prove that containers work cannot be
 * allowed to quietly pass on the host.
 *
 * Not exported, deliberately, and each for its own reason.
 *
 * **The argv.** `dockerRunArgs`, `hardeningArgs`, `mountArgs`, `inspectArgs` and
 * the rest of `./docker-argv` are how one implementation talks to one daemon.
 * They are pure and heavily unit-tested precisely so the confinement can be
 * asserted without a daemon — but a caller composing its own argv is a caller
 * that can drop `--cap-drop=ALL`, and the mount set is this package's entire
 * security boundary. The way to a different container is a different
 * {@link SandboxSpec}.
 *
 * **The failure classifier.** `classifySandboxFailure`, `describeError`,
 * `errorClassOf` and `outcomeOfClass` are how a row is built from what docker
 * left behind. They are not a vocabulary to reason with — the orchestrator
 * matches on the typed errors, which are exported — and three of those names are
 * also exported by `@workspace/harness`, so re-exporting them here would make
 * every importer of both packages alias one set.
 *
 * **The emit path.** `withSandboxEvent`, the progress accumulator, the counter
 * and the subprocess span rule instrument a run; they are not something to
 * instrument with. One row per container is a property of this package rather
 * than a convention its callers follow, and it stops being one the moment a
 * second call site can emit.
 *
 * **`Git`.** A service that runs `git` and `gh` on the host, with the host's
 * credentials, is one refactor away from being an `exec` that takes its command
 * from a database row. It stays inside, and the operations an owner outside
 * actually needs are exported with the runner already provided: clone a
 * workspace, refresh a mirror, and — behind {@link ScopeHistory} — snapshot a
 * shared scope.
 *
 * **The local mode's honesty list.** `unhonouredBy` names every confinement a
 * host process drops, and the local implementation logs it once per run.
 * Exported, it would read as a feature flag to branch on rather than as a
 * warning to read.
 */

export {
  ARTIFACT_DIR_MODE,
  ARTIFACT_OPERATIONS,
  ARTIFACTS_SEGMENT,
  type ArtifactCopy,
  type ArtifactDirInput,
  ArtifactIoFailed,
  type ArtifactLocation,
  ArtifactOperation,
  type ArtifactRef,
  artifactDirOf,
  artifactsRootOf,
  type CopyArtifactInput,
  copyArtifact,
  ensureArtifactDir,
  ensureFileScopeDir,
  extOf,
  type FileScopeDirInput,
  fileScopeDirOf,
  GIT_DIR,
  GLOBAL_SEGMENT,
  globalArtifactsDirOf,
  PROJECTS_SEGMENT,
  type ProjectArtifactsInput,
  type PromoteArtifactInput,
  type PromotionTarget,
  projectArtifactsDirOf,
  promoteArtifact,
  scanArtifacts,
  TASKS_SEGMENT,
  type TaskArtifactsInput,
  taskArtifactsDirOf,
} from "./artifacts";
// Who a run's commits are attributed to, resolved from the token. Exported for
// a check script that wants to print the identity a loop would boot with,
// rather than for the loop itself — `workspaceLayer` reads it on its own.
export {
  committerFromUser,
  GITHUB_USER_URL,
  noReplyEmailFor,
  type ResolveCommitterOptions,
  resolveCommitter,
} from "./committer";
// The skills one run is handed, gathered from every level of its tree. Here
// rather than in `./skills` because it is about a run's directories and not
// about what a skill is: the layout is durable, and this is a copy that dies
// with the run that read it.
export {
  COMPOSED_SKILLS_DIR_MODE,
  COMPOSED_SKILLS_MAX_BYTES,
  COMPOSED_SKILLS_SEGMENT,
  type ComposedSkill,
  type ComposedSkills,
  composedSkillsDirOf,
  composedSkillsRootOf,
  composeSkills,
  composeSkillsScoped,
  releaseComposedSkills,
  type ShadowedSkill,
  SKILL_LEVELS,
  type SkillCompositionInput,
  type SkillLevel,
  type SkillScope,
  skillSearchDirsOf,
} from "./composed-skills";
export { dockerSandbox, dockerSandboxLayer } from "./docker";
export {
  ENV_DIR_MODE,
  ENV_FILE_MODE,
  type EnvFilesWritten,
  GIT_EXCLUDE_HEADER,
  GIT_EXCLUDE_PATH,
  type WriteEnvFilesInput,
  writeEnvFiles,
} from "./env-files";
export {
  CloneFailed,
  ContainerStartFailed,
  DaemonUnreachable,
  EnvFileWriteFailed,
  ImageMissing,
  MountSourceMissing,
  OomKilled,
  SANDBOX_ERROR_CLASSES,
  SANDBOX_EXTRA_OUTCOMES,
  type SandboxError,
  SandboxErrorClass,
  SandboxOutcome,
  SandboxTimedOut,
  TeardownFailed,
} from "./errors";
// The remote redactor, exported because the loop assembles a failure's message
// out of git's own stderr and the sanitizer at that layer covers bearer tokens
// and API keys but not the `user:pass@` a clone URL carries.
export { redactRemote } from "./git";
// The GitHub credential. Exported because the orchestrator hands the same
// token to a container that this package hands to the host's git — one value
// reaching two sides, so the names it travels under are shared, not repeated.
export {
  AGENT_TOKEN_ENV_VAR,
  GH_TOKEN_ENV_VAR,
  GITHUB_TOKEN_ENV_VAR,
  githubTokenEnv,
  MANAGER_TOKEN_ENV_VAR,
  readGithubToken,
  readManagerGithubToken,
} from "./github";
export {
  DEFAULT_CPUS,
  DEFAULT_MEMORY_MB,
  DEFAULT_PIDS_LIMIT,
  DEFAULT_USER,
  defaultHardening,
  type HardeningSpec,
  hardeningFor,
  hostUser,
  SANDBOX_CPUS_ENV_VAR,
  SANDBOX_MEMORY_MB_ENV_VAR,
  type SandboxNetwork,
  sandboxCpusConfig,
  sandboxMemoryMbConfig,
  type TmpfsMount,
} from "./hardening";
// The history of the two folders more than one run can write. A service rather
// than a function, because the identity its commits carry is resolved once for
// the process and the git runner behind it stays inside this package.
export {
  editMessageOf,
  HISTORY_BRANCH,
  HISTORY_PHASES,
  type HistoryPhase,
  historyMessageOf,
  historyScopeOf,
  makeScopeHistory,
  type ScopeCommits,
  type ScopeEditInput,
  type ScopeEditReport,
  ScopeHistory,
  type ScopeHistoryInput,
  type ScopeHistoryInterface,
  type ScopeHistoryOptions,
  type ScopeHistoryReport,
  type SharedScope,
} from "./history";
export {
  buildTag,
  DEFAULT_IMAGE_KIND,
  DEFAULT_SANDBOX_IMAGE,
  IMAGE_KINDS,
  IMAGE_REGISTRY,
  ImageKind,
  imageRef,
  imageRepository,
  LATEST_TAG,
  RECIPE_DIGEST_CHARS,
  sandboxImageFor,
} from "./images";
export {
  type InstructionBudget,
  type InstructionFile,
  instructionDirsOf,
  measureInstructionBudget,
} from "./instruction-budget";
export { localSandbox, localSandboxLayer } from "./local";
export {
  DEFAULT_SANDBOX_KIND,
  logSandboxMode,
  SANDBOX_MODE_ENV_VAR,
  sandboxKindConfig,
  sandboxLayer,
  sandboxLayerFor,
} from "./mode";
export {
  AGENT_HOME_SKILLS_SEGMENT,
  CONTAINER_AGENT_HOME_DIR,
  CONTAINER_CACHE_DIR,
  CONTAINER_EVENT_LOG_DIR,
  CONTAINER_MANAGER_DIR,
  CONTAINER_MANAGER_SCRATCH_DIR,
  CONTAINER_SKILLS_DIR,
  CONTAINER_WORKER_DIR,
  CONTAINER_WORKSPACE_DIR,
  EVENT_LOG_SEGMENT,
  eventLogDirOf,
  FALLBACK_SLUG,
  MANAGER_SEGMENT,
  type ManagerMountSources,
  MOUNT_PURPOSES,
  type Mount,
  type MountExtras,
  MountPurpose,
  type MountSources,
  managerMountsFor,
  mountSourcePaths,
  mountsFor,
  type NestedMountPoint,
  NO_MOUNT_EXTRAS,
  nestedMountPointsOf,
  packageCacheEnv,
  type RunLabels,
  type RunTree,
  runTreeOf,
  SCRATCH_SEGMENT,
  SLUG_MAX_LENGTH,
  slugOf,
  WORKER_SEGMENT,
} from "./mounts";
// The pull request a run's branch has. Exported because the orchestrator's
// terminal path writes it onto the task, and because asking GitHub is how that
// field stays a fact rather than a thing an agent remembered to report.
export {
  choosePullRequest,
  GITHUB_API_ORIGIN,
  type PullRequestLookup,
  pullRequestForBranch,
} from "./pull-request";
export { type LabelledContainer, orphansOf } from "./reap";
export {
  BRANCH_PREFIX,
  baseRefOf,
  branchForTask,
  type Committer,
  cloneIntoWorkspace,
  DEFAULT_COMMITTER,
  FALLBACK_BASE_REF,
  MIRROR_SUFFIX,
  MIRRORS_SEGMENT,
  mirrorDirOf,
  mirrorsRootOf,
  type RepoSourceInput,
  repoLabelOf,
  repoSourceFor,
} from "./repo";
export {
  SANDBOX_EVENT_MARKER,
  SANDBOX_OUTCOMES,
  SANDBOX_RUN_SPAN,
  SandboxEvent,
  type SandboxEventInput,
} from "./sandbox-event";
// What that credential is allowed to do. Exported because the loop says it at
// boot: a token that clones and pushes and then refuses `.github/workflows/` is
// a run that half-finishes, and the only cheap moment to notice is before any
// task has been spent on it.
export {
  type CredentialNote,
  credentialNotes,
  type GithubCredential,
  type GithubTokenKind,
  OWNER_SCOPES,
  probeGithubCredential,
  REQUIRED_SCOPES,
  tokenKindOf,
} from "./scopes";
// A skill, as the files it is. The layout and the lock are here beside the
// artifact folders they are written into; the writing itself is the gateway's,
// which owns the one containment check every path into a scope goes through.
export {
  AGENT_SKILLS_DIR,
  CLAUDE_SKILLS_DIR,
  compareSkillFiles,
  EMPTY_SKILLS_LOCK,
  fetchSkillFiles,
  GITHUB_CONTENTS_ORIGIN,
  parseSkillsLock,
  SKILL_DIFF_CONTENT_MAX,
  SKILL_FILE,
  SKILL_MAX_BYTES,
  SKILL_MAX_DEPTH,
  SKILL_MAX_FILE_BYTES,
  SKILL_MAX_FILES,
  SKILL_SOURCE_REFUSALS,
  SKILLS_LOCK_FILE,
  SKILLS_LOCK_VERSION,
  type SkillFetchInput,
  type SkillFetchResult,
  type SkillFile,
  type SkillFileChange,
  type SkillPaths,
  SkillSourceRefusal,
  SkillSourceUnreadable,
  SkillsLock,
  serializeSkillsLock,
  skillDirOf,
  skillFilePathOf,
  skillHashOf,
  skillLinkOf,
  skillLinkTargetOf,
  skillPathsOf,
  withoutSkill,
  withSkill,
} from "./skills";
export {
  type ContainerHandle,
  identityEnv,
  MATERIALIZE_STRATEGIES,
  type MaterializeInput,
  MaterializeStrategy,
  OUTPUT_STREAMS,
  type OutputChunk,
  OutputStream,
  type RepoSource,
  type RunIdentity,
  type RunWorkspace,
  SANDBOX_KINDS,
  Sandbox,
  type SandboxInterface,
  SandboxKind,
  type SandboxResult,
  type SandboxRunInput,
  type SandboxSpec,
  TEARDOWN_OUTCOMES,
  TeardownOutcome,
  TRACEPARENT_ENV_VAR,
  Workspace,
  type WorkspaceInterface,
} from "./spec";
// The directories a killed process left behind. Exported for the orchestrator's
// boot reconcile, which holds the database half of every join below — this
// package lists and removes, and decides nothing.
export {
  checkoutsOf,
  compositionsOf,
  mirrorKeyOf,
  mirrorsOf,
  removeStrays,
  runDirectoriesOf,
  type StrayDirectory,
  strandedOf,
} from "./sweep";
export {
  CACHES_SEGMENT,
  type CachesDirInput,
  type CloneIntoWorkspace,
  type CloneWorkspaceInput,
  cachesDirOf,
  type LocalWorkspaceOptions,
  localWorkspaceLayer,
  RUN_DIR_MODE,
  WORKSPACE_DIR_MODE,
  WORKSPACES_SEGMENT,
  type WorkspaceDirInput,
  workspaceDirOf,
  workspaceLayer,
  workspacesRootOf,
} from "./workspace";
