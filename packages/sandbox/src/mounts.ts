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
 * Exactly five mounts, and the reasons are each their own.
 *
 * The run directory carries the run's private agent home, its comment marker and
 * its event ledger, and it is mounted whole at {@link CONTAINER_RUN_DIR} rather
 * than as three separate binds. That is what makes the container's view and
 * `@workspace/harness`'s `containerRunLayout` the same layout applied to two
 * roots — a second bind under `/run` would be a second spelling of a path the
 * harness already computes, and a run whose transcript is never found.
 *
 * The workspace is the repo checkout, read-write, because that is the work.
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
 * Never the docker socket. Not read-only, not "just for `docker ps`", not ever:
 * a process that can talk to the daemon can start a container with the host root
 * bind-mounted into it, so that one mount turns a sandbox into host root and
 * every flag in `hardening.ts` becomes decoration.
 *
 * Nothing else either — no host home directory, no `~/.ssh`, no data root. The
 * container reaches the network for everything it is allowed to reach, and the
 * filesystem only for what is listed here.
 */

import { join } from "node:path";
import {
  AGENT_HOME_SEGMENT,
  CONTAINER_RUN_DIR,
  containerRunLayout,
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

/** The run's private agent home inside the container, from the harness layout. */
export const CONTAINER_AGENT_HOME_DIR = containerRunLayout.agentHomeDir;

/** The ledger directory under an already-resolved host run directory. */
export const eventLogDirOf = (runDir: string) =>
  join(runDir, EVENT_LOG_SEGMENT);

/** The agent home under an already-resolved host run directory. */
export const agentHomeDirOf = (runDir: string) =>
  join(runDir, AGENT_HOME_SEGMENT);

/**
 * Why a mount exists. The purpose travels with the mount so a failure names
 * what was missing rather than a path, and so the `atm.sandbox` row can count
 * mounts by kind without parsing them back out of argv.
 */
export const MOUNT_PURPOSES = [
  "run",
  "workspace",
  "task_artifacts",
  "project_artifacts",
  "global_artifacts",
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
 * The exact mount set for one run. Pure, total, and the only place the set is
 * decided.
 *
 * The project folder is the one conditional entry: a task with no project has
 * nothing to mount there, and mounting the global folder twice or an empty
 * placeholder would both be lies the agent could read.
 */
export const mountsFor = (sources: MountSources): readonly Mount[] => {
  const mounts: Mount[] = [
    {
      containerPath: CONTAINER_RUN_DIR,
      hostPath: sources.runDir,
      purpose: "run",
      readOnly: false,
    },
    {
      containerPath: CONTAINER_WORKSPACE_DIR,
      hostPath: sources.workspaceDir,
      purpose: "workspace",
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
