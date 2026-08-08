/**
 * What a run's container can see, as data rather than as strings assembled at a
 * call site.
 *
 * A mount is the sandbox's entire security boundary. Everything else about a
 * container — the capabilities, the user, the limits — bounds what a confused
 * agent can do with what it can already reach; the mount set decides what it can
 * reach at all. So the set is built by one pure function from one record, is
 * closed by construction, and is unit-testable without a daemon: a mount added
 * by hand at a call site is a hole nobody reviews.
 *
 * Six mounts a run always gets — the run directory, the agent home, the package
 * store, and the three scopes of its tree that always exist — a seventh when its
 * task belongs to a project, one when the install shares a skills directory, one
 * when it runs our own entrypoint and one when it is given the board tools. The
 * reasons are each their own.
 *
 * The run directory carries the run's message marker, its turn spec and its
 * event ledger, and it is mounted whole at {@link CONTAINER_RUN_DIR} rather than
 * as three separate binds. That is what makes the container's view and
 * `@workspace/harness`'s `containerRunLayout` the same layout applied to two
 * roots — a second bind under `/run` would be a second spelling of a path the
 * harness already computes, and a run whose transcript is never found.
 *
 * The agent home is one system-owned host directory per provider, mounted
 * read-write at {@link CONTAINER_AGENT_HOME_DIR}, and it is the one mount that
 * is shared between runs. That is deliberate and it is the point: both vendors
 * refresh their subscription token in place, so a private copy per run means
 * every refresh is discarded with the container while the original goes stale.
 * One directory, written by whichever container refreshed last, is the same
 * arrangement several interactive CLI sessions on one laptop already use.
 *
 * It is mounted at the top level rather than under `/run`. It is a different
 * host directory with a different lifetime, and a bind inside a bind is
 * ordering-dependent for no gain.
 *
 * One home, never both. A run uses one provider, and mounting the other
 * vendor's login is a credential handed to a container with nothing to do with
 * it. So the container path is a constant and the host path is chosen per run.
 *
 * The workspace is the repo checkout, read-write, because that is the work.
 *
 * The package cache is one directory under the data root, read-write, shared by
 * every run and every project — the second mount after the agent home that is
 * not private to a run, and for a different reason. These stores are
 * content-addressed, so sharing is where the dedupe comes from: two repos on the
 * same lockfile pin fetch once, and a run starts with a warm store instead of
 * paying the full download every turn. It is a sibling of the workspaces
 * directory rather than anywhere else on the host because pnpm hardlinks out of
 * its store into `node_modules` and a hardlink cannot cross a filesystem; split
 * the two across disks and pnpm silently falls back to copying.
 *
 * Every manager is pointed at it and none is detected — see
 * {@link packageCacheEnv}. A run that installs nothing simply leaves it cold.
 *
 * A poisoned cache spreads: one run can write an artifact a later run installs.
 * That is accepted rather than overlooked. The agent already has network access
 * and push rights, so a per-project store would contain nothing it could not
 * already do and would cost the dedupe that is the whole point.
 *
 * The artifact folders are not three flat directories beside the checkout. They
 * are one tree, and the depth of a directory *is* its scope: {@link
 * CONTAINER_WORKSPACE_DIR} is the global folder, the project's folder hangs
 * under it, the task's folder under that, and the checkout under that. Both
 * agent CLIs read instruction files from the working directory upwards and
 * concatenate them root-down, so a run walking out of its checkout collects
 * house rules, then project conventions, then its own brief, in that order, with
 * nothing to configure. See {@link runTreeOf}.
 *
 * Nesting the destinations is not merging the binds. Each level is still its own
 * bind with its own host path and its own read-only flag; one bind of the whole
 * tree would hand every run every project and every task. The daemon mounts a
 * parent before anything under it, which is already why `/agent-home/skills`
 * works.
 *
 * A worker gets the workspace scope read-only and everything under it
 * read-write, and the read-only flag is the one place that rule is enforced
 * rather than asserted. A worker clones arbitrary repositories; a write above
 * its own task scope is meant to be a proposal a human confirms, and a mount
 * flag makes that true where a sentence in a prompt only asks for it.
 *
 * Project scope is deliberately writable, and it is the one flag here that was
 * relaxed on purpose. A research run leaving a document the next task in the
 * same project reads is worth more than the deliberateness a read-only mount
 * bought, and attribution never depended on that flag — `artifact.lastRunId` is
 * an indexed column with a relation back to the run, and `copyArtifact` already
 * records a sha256. What is genuinely lost is overwrite: two runs writing
 * different names never collide, and a run replacing an existing path is guarded
 * on the host rather than by the mount — `./history` commits both shared scopes
 * around every run, so the replaced bytes are still in the folder's own `git
 * log`.
 *
 * A manager turn gets the workspace scope read-write. It is the role a human is
 * talking to, its own rules live under it, and it reads no untrusted repository.
 *
 * Because a worker's workspace scope is read-only, the daemon cannot create the
 * nested destinations through it: a bind needs its destination to already exist
 * inside the parent's host directory. {@link nestedMountPointsOf} names those
 * directories from the mount set itself, and materialization makes them before
 * the container starts.
 *
 * The operator's own skills directory is mounted read-only at
 * {@link CONTAINER_SKILLS_DIR} when the install names one, and it is the only
 * mount that is a bind inside another bind. That is the point of it: a provider
 * reads its personal skills from a fixed name under its config directory, so
 * the directory has to appear *inside* the agent home or it is not found. The
 * daemon mounts a destination before anything nested under it, which is what
 * makes the ordering safe; the nesting buys the one thing a sibling mount
 * cannot. Read-only, because a run reads skills and an install that let a
 * container rewrite them would be letting one run edit the instructions every
 * later run is given.
 *
 * Mounted rather than copied for the same reason as everything else here: the
 * operator edits the skills in their own directory, and the next container sees
 * the edit without a sync step that can be forgotten.
 *
 * The last two are bundles rather than directories: the turn entrypoint and the
 * board tools, one file each, read-only. Neither is in the image on purpose —
 * the image carries bun, node, git and the agent CLIs, which move on a weekly
 * rebuild, while both bundles are this repository's own code and change every
 * commit, so an image build per commit is the tax they avoid. Read-only because
 * the container runs them and has no business rewriting the host's copy, which
 * every other run on the box is running too. Each is conditional: a container
 * told to run a shell has no entrypoint to mount, and an install with no
 * gateway configured has no board tools to hand out.
 *
 * The board tools are mounted rather than copied onto the run mount, which is
 * what they used to be. The copy was defended as costing less than a mount
 * entry; at 1.7 MB a run it was 77% of everything under `runs/` on the first
 * host to be measured, and it grew with the run count. One entry here, one file
 * on the host, nothing per run.
 *
 * Never the docker socket. Not read-only, not "just for `docker ps`", not ever:
 * a process that can talk to the daemon can start a container with the host root
 * bind-mounted into it, so that one mount turns a sandbox into host root and
 * every flag in `hardening.ts` becomes decoration.
 *
 * Nothing else either — no host home directory, no `~/.ssh`, no data root. The
 * container reaches the network for everything it is allowed to reach, and the
 * filesystem only for what is listed here.
 *
 * There is a second, smaller set. A turn that belongs to a conversation rather
 * than to a task — the manager agent answering a chat message — has no task
 * folder to write and no repo to check out, and it reaches the board over HTTP
 * instead. {@link managerMountsFor} is that set, built here beside the other so
 * both are decided in one file and reviewed together.
 */

import { join } from "node:path";
import {
  CONTAINER_AGENT_MCP_PATH,
  CONTAINER_ENTRYPOINT_PATH,
  CONTAINER_RUN_DIR,
} from "@workspace/harness";
import { Schema } from "effect";

/**
 * The root of a run's tree, and the shallowest scope in it. Fixed, like the run
 * directory: no id appears in it, so a prompt or a transcript cannot leak which
 * run, task or project wrote a file.
 *
 * The host directory behind it is the global artifacts folder, which is why the
 * mount at this path carries the `global_artifacts` purpose. The path is short
 * because every instruction file a run reads names it.
 */
export const CONTAINER_WORKSPACE_DIR = "/workspace";

/** The branch of the tree a dispatched task run works in. */
export const WORKER_SEGMENT = "worker";

/**
 * The branch of the tree the manager agent works in, and the reason project
 * rules never reach a chat turn: the manager's working directory is under here
 * rather than under any project, so its upward walk never crosses one.
 */
export const MANAGER_SEGMENT = "manager";

/** What the working directory is called for a run that has no repository to clone. */
export const SCRATCH_SEGMENT = "scratch";

/**
 * Where the shared package store is mounted. One bind for every manager: the
 * per-manager subdirectories under it are the container's to create, so adding a
 * fifth tool is a variable rather than a mount.
 */
export const CONTAINER_CACHE_DIR = "/cache";

/**
 * Where each package manager is told to keep its store, rooted at whichever
 * path the run actually sees it under — {@link CONTAINER_CACHE_DIR} inside a
 * container, the host directory for a turn that runs as a host process.
 *
 * All four are set on every run and none is detected. A repo using pnpm and a
 * repo using bun get the same variables; whichever tool runs finds its own store
 * warm and the others sit unused. Detecting the package manager per project is a
 * guess that is wrong on the repo that uses two.
 *
 * The npm-shaped names are lowercase because that is the only spelling npm and
 * pnpm read a config key under from the environment. Yarn berry needs both of
 * its names: the folder alone leaves a berry project fetching into the
 * per-project `.yarn/cache`, which is inside the checkout that dies with the
 * run.
 *
 * pnpm gets two names for one directory because it changed which it reads.
 * Through pnpm 10 the store came off `npm_config_store_dir`; pnpm 11 ignores
 * that name and answers `undefined` for `store-dir`, taking the value from
 * `PNPM_CONFIG_STORE_DIR` instead. A run does not choose its pnpm — a repo's
 * `packageManager` field does, and `npx pnpm` takes the newest there is — so
 * both are set and whichever version turns up finds the same store.
 *
 * This also takes installs off `$HOME`. A container runs as the loop process's
 * uid, which on a host where that is a system account is not the image's 1000 —
 * so `$HOME` is not writable and every tool that wants one falls back to `/tmp`,
 * a tmpfs billed against the container's memory limit.
 */
export const packageCacheEnv = (
  cacheRoot: string
): Readonly<Record<string, string>> => ({
  BUN_INSTALL_CACHE_DIR: join(cacheRoot, "bun"),
  npm_config_cache: join(cacheRoot, "npm"),
  npm_config_store_dir: join(cacheRoot, "pnpm"),
  PNPM_CONFIG_STORE_DIR: join(cacheRoot, "pnpm"),
  YARN_ENABLE_GLOBAL_CACHE: "true",
  YARN_GLOBAL_FOLDER: join(cacheRoot, "yarn"),
});

/** Everything a worker run is given, below the workspace scope. */
export const CONTAINER_WORKER_DIR = join(
  CONTAINER_WORKSPACE_DIR,
  WORKER_SEGMENT
);

/**
 * The manager's own directory. Not a mount: it is an ordinary directory inside
 * the workspace scope's host folder, so the rules a human writes at
 * `<manager>/CLAUDE.md` arrive through the bind that is already there. A worker
 * can see it and never walks into it, because its working directory is under
 * {@link CONTAINER_WORKER_DIR}.
 */
export const CONTAINER_MANAGER_DIR = join(
  CONTAINER_WORKSPACE_DIR,
  MANAGER_SEGMENT
);

/**
 * Where a chat turn works. A manager reads the board over HTTP and has no
 * checkout, but a CLI still puts temporary files somewhere and a container whose
 * working directory does not exist fails to start — so it gets the run's own
 * throwaway directory, mounted at a fixed name under the manager's scope.
 */
export const CONTAINER_MANAGER_SCRATCH_DIR = join(
  CONTAINER_MANAGER_DIR,
  SCRATCH_SEGMENT
);

/**
 * How long a path segment made from a human-written name may be. Generous
 * enough that a real project or task name survives recognisably, short enough
 * that four levels plus a filename stay well inside any path limit an agent's
 * tooling has.
 */
export const SLUG_MAX_LENGTH = 48;

/** What a name that slugs to nothing becomes, so a path is never empty. */
export const FALLBACK_SLUG = "untitled";

const NON_SLUG_CHARS = /[^a-z0-9]+/g;
const EDGE_DASHES = /^-+|-+$/g;

/**
 * One path segment from a human-written name: lowercase, anything that is not a
 * letter or a digit collapsed to a dash, trimmed, and capped.
 *
 * A slug rather than an id, and that is safe here for a structural reason rather
 * than a hopeful one: exactly one project directory and one task directory is
 * ever mounted into a container, so two projects that slug the same can never
 * meet inside one run. There is nothing to collide with. The host directories
 * stay keyed by id, so a rename relabels the next run and moves nothing.
 *
 * The reason to prefer the slug is the same rule {@link CONTAINER_WORKSPACE_DIR}
 * already follows: an id in a container path is an id a transcript can leak, and
 * a path an agent reads aloud should say what the directory is for.
 *
 * A name written entirely outside `a-z0-9` — one in a non-Latin script, or an
 * emoji — slugs to nothing and becomes {@link FALLBACK_SLUG}. That is a dull
 * path, not a broken one, and it is why the fallback exists at all.
 */
export const slugOf = (label: string) => {
  const collapsed = label
    .toLowerCase()
    .replace(NON_SLUG_CHARS, "-")
    .replace(EDGE_DASHES, "");
  // Trimmed again after the cap: slicing mid-word can leave the dash that
  // replaced a space sitting at the end.
  const capped = collapsed.slice(0, SLUG_MAX_LENGTH).replace(EDGE_DASHES, "");
  return capped.length === 0 ? FALLBACK_SLUG : capped;
};

/**
 * The human-written names a run's tree is spelled with. Names, never ids — see
 * {@link slugOf} — and each one nullable exactly where the thing it names can be
 * absent.
 */
export interface RunLabels {
  /** The project's name, or null for a task that belongs to no project. */
  readonly project: string | null;
  /**
   * The repository the run checks out, or null for a run with nothing to clone.
   * An `owner/name` label is fine: the slug flattens it to one segment, so the
   * checkout is one directory below the task scope whatever it is called.
   */
  readonly repo: string | null;
  /** The task's title. Always present — every worker run is about a task. */
  readonly task: string;
}

/**
 * Where one run's four scopes sit inside its container. Computed, not
 * configured: the mount set and every prompt that names a directory read the
 * same record, so a path an agent is told about and a path it can actually write
 * cannot drift apart.
 */
export interface RunTree {
  /**
   * The working directory: the checkout, or the scratch directory for a run with
   * no repository. Deepest on purpose — both providers walk up from here, so
   * starting anywhere shallower leaves the most specific rules unread.
   */
  readonly cwd: string;
  /** The project scope, or null for a task with no project. */
  readonly projectScope: string | null;
  /** The task scope. This run's own output, and the one shared scope it may write. */
  readonly taskScope: string;
  /** The workspace scope. House rules and reference material for every run. */
  readonly workspaceScope: string;
}

/**
 * A run's tree from its labels. Pure, total, and the only place the shape is
 * decided.
 *
 * A task with no project gets a shallower path rather than a placeholder
 * segment: `worker/<task>` instead of `worker/_/<task>`. The alternative is an
 * empty directory the agent can open, which is a lie it can read — the same
 * reason nothing is mounted at the project scope in that case.
 *
 * A run with no repository gets {@link SCRATCH_SEGMENT} where the checkout would
 * be, at the same depth and from the same host directory. The level exists
 * either way, so the walk an agent's tooling performs is the same walk.
 */
export const runTreeOf = (labels: RunLabels): RunTree => {
  const projectScope =
    labels.project === null
      ? null
      : join(CONTAINER_WORKER_DIR, slugOf(labels.project));
  const taskScope = join(
    projectScope ?? CONTAINER_WORKER_DIR,
    slugOf(labels.task)
  );
  return {
    cwd: join(
      taskScope,
      labels.repo === null ? SCRATCH_SEGMENT : slugOf(labels.repo)
    ),
    projectScope,
    taskScope,
    workspaceScope: CONTAINER_WORKSPACE_DIR,
  };
};

/**
 * The directory under a run's own directory where the wide-event ledger is
 * written, on both sides of the mount. `@workspace/telemetry` reads
 * `EVENT_LOG_DIR` and appends one file per service; pointing it here is what
 * makes the `atm.turn` row a container writes land on the host and join the
 * `atm.run` row the loop wrote for the same work.
 *
 * A segment rather than a pair of absolute constants, because it is applied to
 * the host run directory and to {@link CONTAINER_RUN_DIR} — the two views
 * cannot disagree about anything but the prefix.
 */
export const EVENT_LOG_SEGMENT = "events";

/** The ledger directory inside the container, which is where `EVENT_LOG_DIR` points. */
export const CONTAINER_EVENT_LOG_DIR = join(
  CONTAINER_RUN_DIR,
  EVENT_LOG_SEGMENT
);

/**
 * Where the run's provider keeps its config directory inside the container.
 * Constant, and top level: the host path differs per provider and per operator,
 * and neither fact belongs anywhere the agent can read it.
 */
export const CONTAINER_AGENT_HOME_DIR = "/agent-home";

/**
 * Where a run finds the skills the operator shares with it. Under the agent
 * home and named `skills`, because that is where a provider looks for the
 * personal skills of whoever it is running as — the path is the provider's, not
 * ours, which is why it is derived from {@link CONTAINER_AGENT_HOME_DIR} rather
 * than chosen.
 */
export const CONTAINER_SKILLS_DIR = join(CONTAINER_AGENT_HOME_DIR, "skills");

/** The ledger directory under an already-resolved host run directory. */
export const eventLogDirOf = (runDir: string) =>
  join(runDir, EVENT_LOG_SEGMENT);

/**
 * Why a mount exists. The purpose travels with the mount so a failure names
 * what was missing rather than a path, and so the `atm.sandbox` row can count
 * mounts by kind without parsing them back out of argv.
 */
export const MOUNT_PURPOSES = [
  "run",
  "agent_home",
  "workspace",
  "cache",
  "task_artifacts",
  "project_artifacts",
  "global_artifacts",
  "skills",
  "entrypoint",
  "agent_mcp",
] as const;

/** What one mount is for. */
export const MountPurpose = Schema.Literals(MOUNT_PURPOSES);
export type MountPurpose = typeof MountPurpose.Type;

/** One bind mount: a host path, where it appears inside, and whether it is writable. */
export interface Mount {
  /** Absolute path inside the container. Fixed per purpose, never derived from an id. */
  readonly containerPath: string;
  /** Absolute path on the host. Must exist before the container starts. */
  readonly hostPath: string;
  readonly purpose: MountPurpose;
  /**
   * True for a worker's workspace scope and the two mounts an install shares
   * with every run — the operator's skills and the entrypoint bundle — and
   * false for everything a run works in.
   */
  readonly readOnly: boolean;
}

/**
 * The host paths one run needs mounted. Produced by the workspace
 * materialization step and consumed here — a record rather than five arguments,
 * so a caller cannot transpose the project folder and the global one and hand a
 * run write access to the wrong tree.
 */
export interface MountSources {
  /**
   * The host directory holding this run's provider login. System-owned, shared
   * by every run on the host, and never created by us — see
   * {@link CONTAINER_AGENT_HOME_DIR}.
   */
  readonly agentHomeDir: string;
  /**
   * The shared package store on the host, one directory for every run on the
   * box. Read-write, and outlives the run that filled it — see
   * {@link CONTAINER_CACHE_DIR}.
   */
  readonly cacheDir: string;
  /**
   * The global promoted folder, which is the host side of the workspace scope.
   * Read-only to a worker, read-write to a manager.
   */
  readonly globalArtifactsDir: string;
  /**
   * The names the run's container paths are spelled with. Carried rather than
   * the {@link RunTree} itself so that there is one place the tree is computed
   * — a caller that could hand over a tree could hand over a tree that disagrees
   * with the host directories beside it.
   */
  readonly labels: RunLabels;
  /** The project's promoted folder, or null for a task with no project. */
  readonly projectArtifactsDir: string | null;
  /** The run's own directory: agent home, message marker, event ledger. */
  readonly runDir: string;
  /** The task's own artifacts folder: this run's output, and the innermost scope. */
  readonly taskArtifactsDir: string;
  /** The repo checkout, or a scratch directory for a task with no repo. */
  readonly workspaceDir: string;
}

/**
 * What is mounted on top of the directories the run's own materialization
 * produced. Separate from {@link MountSources} because nothing here comes from
 * a run: the entrypoint is one file under the data root, written by the build
 * script and shared by every container on the host.
 */
export interface MountExtras {
  /**
   * The bundled board tools on the host, mounted read-only at
   * {@link CONTAINER_AGENT_MCP_PATH}. Null on an install that named no gateway,
   * which runs every turn without board tools — a smaller agent, not a broken
   * one. The orchestrator has already checked the file is there by the time it
   * names it here, so that a host with no bundle fails as the missing bundle it
   * is rather than as a mount source the daemon could not find.
   */
  readonly agentMcpPath: string | null;
  /**
   * The bundled turn entrypoint on the host, mounted read-only at
   * {@link CONTAINER_ENTRYPOINT_PATH}. Null for a container that runs something
   * the image already has — a shell, in the checks that prove the plumbing.
   */
  readonly entrypointPath: string | null;
  /**
   * The operator's skills directory on the host, mounted read-only at
   * {@link CONTAINER_SKILLS_DIR}. Null on an install that shares none, which is
   * the default: a run reaches nothing of the host's until an operator names
   * the directory it may read.
   */
  readonly skillsDir: string | null;
}

/** What a container that brings its own command gets: the five run mounts. */
export const NO_MOUNT_EXTRAS: MountExtras = {
  agentMcpPath: null,
  entrypointPath: null,
  skillsDir: null,
};

/**
 * The skills mount, or nothing. One function for both mount sets: what a
 * conversation and a task may read of the host's skills is the same answer, and
 * two copies of it is where they would come to differ.
 */
const skillsMounts = (extras: MountExtras): readonly Mount[] =>
  extras.skillsDir === null
    ? []
    : [
        {
          containerPath: CONTAINER_SKILLS_DIR,
          hostPath: extras.skillsDir,
          purpose: "skills",
          readOnly: true,
        },
      ];

/**
 * The host's two bundles, whichever of them this turn was given. One function
 * for both mount sets, like {@link skillsMounts} and for the stronger version
 * of the same reason: a manager turn is the one that uses the board tools most,
 * so a copy of this that drifted would take them away from exactly the role
 * that needs them.
 *
 * Read-only on both. One file on the host serves every container, so a
 * container that could write it would be rewriting the code every other run on
 * the box is executing.
 */
const bundleMounts = (extras: MountExtras): readonly Mount[] => {
  const mounts: Mount[] = [];
  if (extras.entrypointPath !== null) {
    mounts.push({
      containerPath: CONTAINER_ENTRYPOINT_PATH,
      hostPath: extras.entrypointPath,
      purpose: "entrypoint",
      readOnly: true,
    });
  }
  if (extras.agentMcpPath !== null) {
    mounts.push({
      containerPath: CONTAINER_AGENT_MCP_PATH,
      hostPath: extras.agentMcpPath,
      purpose: "agent_mcp",
      readOnly: true,
    });
  }
  return mounts;
};

/**
 * The exact mount set for one run. Pure, total, and the only place the set is
 * decided.
 *
 * The four tree mounts are emitted parent first, which is how they read and
 * also the order the daemon needs them established in.
 *
 * Four conditional entries, and none is a default that hides a decision. A task
 * with no project has nothing to mount and nowhere to mount it, and mounting
 * the global folder twice or an empty placeholder would both be lies the agent
 * could read. An install that shares no skills directory shares none. A
 * container running a command out of the image needs neither the entrypoint
 * bundle nor the board tools, and mounting a path that may not exist would
 * refuse to start it.
 */
export const mountsFor = (
  sources: MountSources,
  extras: MountExtras = NO_MOUNT_EXTRAS
): readonly Mount[] => {
  const tree = runTreeOf(sources.labels);
  const mounts: Mount[] = [
    {
      containerPath: CONTAINER_RUN_DIR,
      hostPath: sources.runDir,
      purpose: "run",
      readOnly: false,
    },
    {
      containerPath: CONTAINER_AGENT_HOME_DIR,
      hostPath: sources.agentHomeDir,
      // Writable, and that is the whole point of mounting it rather than
      // copying it: the vendor refreshes its token in place, and a read-only
      // mount would make every refresh fail.
      purpose: "agent_home",
      readOnly: false,
    },
    {
      containerPath: tree.workspaceScope,
      hostPath: sources.globalArtifactsDir,
      // The host directory is the global artifacts folder, so the purpose names
      // that rather than the container path it now answers to.
      purpose: "global_artifacts",
      // The one read-only scope, and the whole of a worker's write boundary: it
      // clones untrusted repositories, and everything above its task scope is a
      // proposal rather than an edit.
      readOnly: true,
    },
  ];
  // Both nulls state the same fact and both are checked, because a caller that
  // passed one without the other would otherwise get a project folder mounted
  // where no project scope exists, or a scope with nothing behind it.
  if (sources.projectArtifactsDir !== null && tree.projectScope !== null) {
    mounts.push({
      containerPath: tree.projectScope,
      hostPath: sources.projectArtifactsDir,
      // Writable on purpose: a research run leaves a document the next task in
      // the same project reads, and overwrite is guarded on the host.
      purpose: "project_artifacts",
      readOnly: false,
    });
  }
  mounts.push(
    {
      containerPath: tree.taskScope,
      hostPath: sources.taskArtifactsDir,
      purpose: "task_artifacts",
      readOnly: false,
    },
    {
      containerPath: tree.cwd,
      hostPath: sources.workspaceDir,
      purpose: "workspace",
      readOnly: false,
    },
    {
      containerPath: CONTAINER_CACHE_DIR,
      hostPath: sources.cacheDir,
      // Writable, and shared: a run that could only read the store would warm
      // nothing for the next one, which is the entire point of the mount.
      purpose: "cache",
      readOnly: false,
    }
  );
  mounts.push(...skillsMounts(extras), ...bundleMounts(extras));
  return mounts;
};

/**
 * The subset of {@link MountSources} a turn that is about no task can supply.
 *
 * Derived rather than restated, so a field renamed on the full record is a
 * compile error here rather than a mount that quietly stops being produced.
 */
export type ManagerMountSources = Pick<
  MountSources,
  "agentHomeDir" | "globalArtifactsDir" | "runDir" | "workspaceDir"
>;

/**
 * The mount set for a turn that belongs to a conversation rather than to a
 * task: its own run directory, the provider's agent home, the workspace scope,
 * and a scratch directory under it.
 *
 * A function beside {@link mountsFor} rather than a nullable field on it. The
 * two sets differ in what they are allowed to reach, not in a detail — this one
 * has no task folder to write and no repo to read, so making the task folder
 * optional would let a worker run dispatched with a missing path fall through
 * to this shape silently. Separate functions mean the caller names which kind
 * of turn it is starting, and both remain closed by construction.
 *
 * The skills directory is shared with a conversation on the same terms as with
 * a run: the manager is the role that reads the board and writes the briefs, so
 * the operator's own instructions are the most use to it of anywhere.
 *
 * The package cache is not here, and neither are the variables that name it. A
 * chat turn answers over HTTP and installs nothing, so the mount would be a
 * shared writable directory handed to a turn with no use for it.
 *
 * The workspace scope is read-write here, and that is the one flag that differs
 * from a worker's. The manager is the role a human is talking to, it reads no
 * untrusted repository, and the house rules it is asked to edit live in that
 * folder — so the scope a worker may only propose changes to is one this turn
 * simply writes. Its own rules sit at {@link CONTAINER_MANAGER_DIR}, inside the
 * same bind, which is why there is no mount for them.
 *
 * The scratch directory is still mounted, and it is still read-write. The
 * manager works over HTTP and needs no checkout, but a scratch directory is
 * where a CLI puts its temporary files, and a container whose working directory
 * does not exist fails to start.
 */
export const managerMountsFor = (
  sources: ManagerMountSources,
  extras: MountExtras = NO_MOUNT_EXTRAS
): readonly Mount[] => {
  const mounts: Mount[] = [
    {
      containerPath: CONTAINER_RUN_DIR,
      hostPath: sources.runDir,
      purpose: "run",
      readOnly: false,
    },
    {
      containerPath: CONTAINER_AGENT_HOME_DIR,
      hostPath: sources.agentHomeDir,
      purpose: "agent_home",
      readOnly: false,
    },
    {
      containerPath: CONTAINER_WORKSPACE_DIR,
      hostPath: sources.globalArtifactsDir,
      purpose: "global_artifacts",
      readOnly: false,
    },
    {
      containerPath: CONTAINER_MANAGER_SCRATCH_DIR,
      hostPath: sources.workspaceDir,
      purpose: "workspace",
      readOnly: false,
    },
    ...skillsMounts(extras),
  ];
  mounts.push(...bundleMounts(extras));
  return mounts;
};

/**
 * One mount as `docker run` argv.
 *
 * `--mount` rather than `-v`, and that is the whole reason this is a function
 * rather than a template string at a call site: `-v` creates an empty directory
 * when the host path does not exist, so a typo'd artifacts path becomes a run
 * that writes its output into a directory nobody will ever look in, silently.
 * `--mount` refuses to start the container instead, which is a
 * `Sandbox.MountSourceMissing` a human reads.
 */
export const mountArg = (mount: Mount) => {
  const parts = [
    "type=bind",
    `src=${mount.hostPath}`,
    `dst=${mount.containerPath}`,
  ];
  if (mount.readOnly) {
    parts.push("readonly");
  }
  return `--mount=${parts.join(",")}`;
};

/** The mount half of a run's argv, in the order the mounts were built. */
export const mountArgs = (mounts: readonly Mount[]) => mounts.map(mountArg);

/** The host paths that must exist before the container starts, with their purpose. */
export const mountSourcePaths = (mounts: readonly Mount[]) =>
  mounts.map((mount) => ({ path: mount.hostPath, purpose: mount.purpose }));

/**
 * A directory that has to be made on the host so a nested bind has somewhere to
 * land. Shaped like an entry of {@link mountSourcePaths}, so the same
 * "make it, or fail as a missing mount source" step serves both.
 */
export interface NestedMountPoint {
  /** The host path to create: the parent's host directory plus the child's tail. */
  readonly path: string;
  /** The mount that fails to start without it, so the failure names the right thing. */
  readonly purpose: MountPurpose;
}

/**
 * True when `child` sits below `parent`, counted in segments rather than
 * characters — `/workspace-scratch` is not under `/workspace`, and a raw string
 * prefix would say it was.
 *
 * Exported for `./instruction-budget`, which walks the same tree in the other
 * direction: this file asks which host directory a nested destination belongs
 * in, and that one asks which host directory each level of a run's tree is.
 */
export const isUnder = (child: string, parent: string) =>
  child.startsWith(`${parent}/`);

/**
 * Every directory that must exist inside another mount's host directory before
 * the container starts.
 *
 * A bind needs its destination to already be there. Where the destination is
 * inside another bind, "there" means inside that bind's *host* directory — and
 * docker will create it for a writable parent, but a worker's workspace scope is
 * read-only, so the daemon cannot. Pre-creating them from the mount set is what
 * makes a read-only parent workable at all, and taking the list from the set
 * rather than from a constant keeps it correct when the tree changes shape.
 *
 * The parent is the *deepest* other mount that covers the path, because that is
 * the bind the destination will actually be looked up in: the task scope's
 * directory belongs inside the project's host folder, not inside the global one.
 *
 * Every entry is a directory. The one bind of a file — the entrypoint bundle —
 * is at a top-level path under no other mount, so it never appears here.
 */
export const nestedMountPointsOf = (
  mounts: readonly Mount[]
): readonly NestedMountPoint[] =>
  mounts.flatMap((mount) => {
    const [parent] = mounts
      .filter((other) => isUnder(mount.containerPath, other.containerPath))
      .sort((a, b) => b.containerPath.length - a.containerPath.length);
    return parent === undefined
      ? []
      : [
          {
            path: join(
              parent.hostPath,
              mount.containerPath.slice(parent.containerPath.length)
            ),
            purpose: mount.purpose,
          },
        ];
  });
