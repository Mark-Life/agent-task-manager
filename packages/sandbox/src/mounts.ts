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
 * Seven mounts a run always gets, one it gets when the install shares a skills
 * directory and one when it runs our own entrypoint, and the reasons are each
 * their own.
 *
 * The run directory carries the run's comment marker, its turn spec and its
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
 * The three artifact folders are the scope rule from the domain made physical:
 * the task's own folder is read-write, the project's promoted folder and the
 * global folder are read-only. The read-only flags are load-bearing, not
 * defensive. If any run could write the shared folders, promoted material would
 * drift with no audit and no way to tell which run changed what — and the
 * evidence would be the thing that got overwritten. Promotion is a deliberate
 * act performed by the gateway, on the host, against a database row; that
 * separation *is* the audit trail, and a writable mount erases it.
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
 * The last is the bundled turn entrypoint, read-only, and it is a file rather
 * than a directory. It is not in the image on purpose: the image carries bun,
 * node, git and the agent CLIs, which move on a weekly rebuild, while the
 * entrypoint is this repository's own code and changes every commit — so an
 * image build per commit is the tax it avoids. Read-only because the container
 * runs it and has no business rewriting the host's copy of it, and conditional
 * because a container told to run a shell has no entrypoint to mount.
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
  CONTAINER_ENTRYPOINT_PATH,
  CONTAINER_RUN_DIR,
} from "@workspace/harness";
import { Schema } from "effect";

/**
 * Where the repo checkout is mounted. Fixed, like the run directory: the run id
 * lives in the host path and nowhere the agent can read it, so a prompt or a
 * transcript cannot leak which run wrote it.
 */
export const CONTAINER_WORKSPACE_DIR = "/workspace";

/** The parent of the three artifact folders inside the container. */
export const CONTAINER_ARTIFACTS_DIR = "/artifacts";

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

/**
 * The three artifact folders as the container sees them, one per
 * `ArtifactScope`. Flat and named after the scope, so the one line of prompt
 * that explains artifacts to an agent is the whole interface.
 */
export const CONTAINER_ARTIFACT_DIR = {
  global: join(CONTAINER_ARTIFACTS_DIR, "global"),
  project: join(CONTAINER_ARTIFACTS_DIR, "project"),
  task: join(CONTAINER_ARTIFACTS_DIR, "task"),
} as const;

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
  /** True for the shared artifact folders, false for everything a run owns. */
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
  /** The global promoted folder. Read-only. */
  readonly globalArtifactsDir: string;
  /** The project's promoted folder, or null for a task with no project. */
  readonly projectArtifactsDir: string | null;
  /** The run's own directory: agent home, comment marker, event ledger. */
  readonly runDir: string;
  /** The task's own artifacts folder. The only artifact folder a run may write. */
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
 * The exact mount set for one run. Pure, total, and the only place the set is
 * decided.
 *
 * Two conditional entries, and neither is a default that hides a decision. A
 * task with no project has nothing to mount at the project folder, and mounting
 * the global folder twice or an empty placeholder would both be lies the agent
 * could read. A container running a command out of the image needs no
 * entrypoint bundle, and mounting a path that may not exist would refuse to
 * start it.
 */
export const mountsFor = (
  sources: MountSources,
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
      // Writable, and that is the whole point of mounting it rather than
      // copying it: the vendor refreshes its token in place, and a read-only
      // mount would make every refresh fail.
      purpose: "agent_home",
      readOnly: false,
    },
    {
      containerPath: CONTAINER_WORKSPACE_DIR,
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
    },
    {
      containerPath: CONTAINER_ARTIFACT_DIR.task,
      hostPath: sources.taskArtifactsDir,
      purpose: "task_artifacts",
      readOnly: false,
    },
  ];
  if (sources.projectArtifactsDir !== null) {
    mounts.push({
      containerPath: CONTAINER_ARTIFACT_DIR.project,
      hostPath: sources.projectArtifactsDir,
      purpose: "project_artifacts",
      readOnly: true,
    });
  }
  mounts.push({
    containerPath: CONTAINER_ARTIFACT_DIR.global,
    hostPath: sources.globalArtifactsDir,
    purpose: "global_artifacts",
    readOnly: true,
  });
  mounts.push(...skillsMounts(extras));
  if (extras.entrypointPath !== null) {
    mounts.push({
      containerPath: CONTAINER_ENTRYPOINT_PATH,
      hostPath: extras.entrypointPath,
      purpose: "entrypoint",
      readOnly: true,
    });
  }
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
 * task: its own run directory, the provider's agent home, an empty workspace,
 * and the global promoted folder read-only.
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
 * The workspace is still mounted, and it is still read-write. The manager works
 * over HTTP and needs no checkout, but a scratch directory is where a CLI puts
 * its temporary files, and a container whose working directory does not exist
 * fails to start.
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
      hostPath: sources.workspaceDir,
      purpose: "workspace",
      readOnly: false,
    },
    {
      containerPath: CONTAINER_ARTIFACT_DIR.global,
      hostPath: sources.globalArtifactsDir,
      purpose: "global_artifacts",
      readOnly: true,
    },
    ...skillsMounts(extras),
  ];
  if (extras.entrypointPath !== null) {
    mounts.push({
      containerPath: CONTAINER_ENTRYPOINT_PATH,
      hostPath: extras.entrypointPath,
      purpose: "entrypoint",
      readOnly: true,
    });
  }
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
