/**
 * Giving a run its directories off local disk, and taking the throwaway ones
 * back when it ends. The local half of {@link WorkspaceInterface} — the bucket
 * half materializes and persists instead, and the agent sees a plain directory
 * either way.
 *
 * **The per-kind seam is one branch, and it is the whole point.** A task with a
 * repo gets a fresh clone; a task without one gets an empty directory. That is
 * the entire difference between "ship feature X in repo Y" and "plan four days
 * in Budapest": both are a brief in, an agent in a container, and an artifact
 * out. Every other axis — the image, the tools, the mounts, the event stream —
 * is identical, and keeping the difference to this single `if` is what stops a
 * second kind of run from growing a second orchestrator behind it. If a third
 * kind of workspace ever appears it belongs here, beside these two, and nowhere
 * else.
 *
 * **The checkout is not under the run directory.** `runs/<runId>` is mounted
 * whole at `/run` and holds the run's credentials; nesting the workspace inside
 * it would present the repo twice to the container and put a checkout an agent
 * writes to inside the directory holding its subscription token. So the
 * checkout is a sibling tree, `workspaces/<runId>`, keyed by the same id.
 *
 * **The checkout dies with the scope; nothing else does.** A run's durable
 * output is a pushed branch or a file in the artifacts mount — anything left
 * only in the checkout was scratch, and keeping it would mean a data root that
 * grows by a repo per run. The run directory outlives the scope on purpose: the
 * transcript and the event ledger are read off it after the container is gone,
 * and the artifact folders outlive it because they are the point.
 */

import { join } from "node:path";
import type { RunId } from "@workspace/domain";
import { runDirOf } from "@workspace/harness";
import { Effect, Layer } from "effect";
import { FileSystem } from "effect/FileSystem";
import { type ArtifactLocation, ensureArtifactDir } from "./artifacts";
import { type CloneFailed, MountSourceMissing } from "./errors";
import { eventLogDirOf, type MountPurpose } from "./mounts";
import { cloneIntoWorkspace } from "./repo";
import {
  type MaterializeInput,
  type RepoSource,
  type RunWorkspace,
  Workspace,
  type WorkspaceInterface,
} from "./spec";

/** Directory under the data root holding one checkout per run. */
export const WORKSPACES_SEGMENT = "workspaces";

/**
 * Mode for every directory a run is handed. The same value the artifact folders
 * get, for the same reason: what a run may and may not write is stated by the
 * mount's read-only flag, and a unix mode that disagreed with it would be a
 * second answer to a question the mount already settles.
 */
export const RUN_DIR_MODE = 0o755;

/** What names one run's checkout on the host. */
export interface WorkspaceDirInput {
  readonly dataRoot: string;
  readonly runId: RunId;
}

/** The run's checkout on the host, sibling to its run directory. */
export const workspaceDirOf = (input: WorkspaceDirInput) =>
  join(input.dataRoot, WORKSPACES_SEGMENT, input.runId);

/** What a clone is asked to produce. */
export interface CloneWorkspaceInput {
  readonly repo: RepoSource;
  /** An existing empty directory. The clone fills it; it does not create it. */
  readonly targetDir: string;
}

/**
 * Putting a repo into a directory. Implemented by `./repo` against a host-side
 * bare mirror, and taken as a parameter here rather than imported so that the
 * one branch this module exists for can be tested without git, a mirror, or a
 * network.
 *
 * The effect carries no requirements: whatever the clone needs — a filesystem,
 * a command executor — is resolved when the layer is built, which is what keeps
 * `materialize` at `Scope` alone and matching {@link WorkspaceInterface}.
 */
export type CloneIntoWorkspace = (
  input: CloneWorkspaceInput
) => Effect.Effect<void, CloneFailed>;

/** What the local materializer is built from. */
export interface LocalWorkspaceOptions {
  readonly clone: CloneIntoWorkspace;
}

/**
 * Builds the local materializer.
 *
 * The filesystem is acquired once, here, and closed over: `materialize` has to
 * answer with `Scope` as its only requirement, so it cannot be the thing that
 * asks for a `FileSystem`.
 */
export const makeLocalWorkspace = Effect.fnUntraced(function* (
  options: LocalWorkspaceOptions
) {
  const fs = yield* FileSystem;

  /**
   * Creates a directory a container is about to mount.
   *
   * The failure is a `Sandbox.MountSourceMissing` naming the purpose, because
   * that is what the operator needs: `--mount` refuses a missing source with a
   * message about an "invalid mount config" that names none of the five paths,
   * and a run that cannot create its own event directory fails for exactly the
   * same reason as one whose artifacts folder was deleted underneath it.
   */
  const ensureMountSource = (input: {
    readonly path: string;
    readonly purpose: MountPurpose;
  }) =>
    fs.makeDirectory(input.path, { mode: RUN_DIR_MODE, recursive: true }).pipe(
      Effect.tapError((cause) =>
        Effect.logWarning("mount source not created", {
          cause,
          path: input.path,
        })
      ),
      Effect.mapError(
        () =>
          new MountSourceMissing({
            hostPath: input.path,
            purpose: input.purpose,
          })
      ),
      Effect.as(input.path)
    );

  /** One artifact folder, created and reported against the mount it serves. */
  const ensureArtifacts = (input: {
    readonly dataRoot: string;
    readonly location: ArtifactLocation;
    readonly purpose: MountPurpose;
  }) =>
    ensureArtifactDir({
      dataRoot: input.dataRoot,
      location: input.location,
    }).pipe(
      Effect.provideService(FileSystem, fs),
      Effect.tapError((error) =>
        Effect.logWarning("artifact folder not created", error)
      ),
      Effect.mapError(
        (error) =>
          new MountSourceMissing({
            hostPath: error.path,
            purpose: input.purpose,
          })
      )
    );

  /**
   * Removes the checkout. Logged and swallowed on failure, like every teardown
   * that follows work which already succeeded or failed on its own terms — a
   * directory left behind is disk to reclaim, not the run's outcome, and
   * reporting it as one would misstate both.
   */
  const releaseWorkspace = (workspaceDir: string) =>
    fs.remove(workspaceDir, { force: true, recursive: true }).pipe(
      Effect.tapError((cause) =>
        Effect.logWarning("checkout not removed", { cause, path: workspaceDir })
      ),
      Effect.ignore
    );

  const materialize = Effect.fn("Workspace.materialize")(function* (
    input: MaterializeInput
  ) {
    const { dataRoot, identity, projectId, repo } = input;
    yield* Effect.annotateCurrentSpan({
      hasProject: projectId !== null,
      hasRepo: repo !== null,
      runId: identity.runId,
    });

    // The run directory and its ledger directory: the harness computes the
    // layout under both roots, but nothing on the host creates the ledger
    // directory, and `EVENT_LOG_DIR` inside the container points straight at
    // it. A missing one is a run whose `atm.turn` rows are written nowhere.
    const runDir = yield* ensureMountSource({
      path: runDirOf({ dataRoot, runId: identity.runId }),
      purpose: "run",
    });
    yield* ensureMountSource({
      path: eventLogDirOf(runDir),
      purpose: "run",
    });

    const globalArtifactsDir = yield* ensureArtifacts({
      dataRoot,
      location: { scope: "global" },
      purpose: "global_artifacts",
    });
    const taskArtifactsDir = yield* ensureArtifacts({
      dataRoot,
      location: { scope: "task", taskId: identity.taskId },
      purpose: "task_artifacts",
    });
    // A task with no project has no promoted folder to show, and mounting the
    // global one twice or an empty placeholder would both be lies the agent
    // could read.
    const projectArtifactsDir =
      projectId === null
        ? null
        : yield* ensureArtifacts({
            dataRoot,
            location: { projectId, scope: "project" },
            purpose: "project_artifacts",
          });

    // Creating the directory is the acquire, so a clone that fails halfway
    // still leaves a registered release: the alternative is a half-cloned repo
    // sitting in the data root until someone notices.
    const workspaceDir = yield* Effect.acquireRelease(
      ensureMountSource({
        path: workspaceDirOf({ dataRoot, runId: identity.runId }),
        purpose: "workspace",
      }),
      releaseWorkspace
    );

    // The seam. A repo means a fresh clone off the host-side mirror and a
    // branch to push; no repo means the empty directory is already the answer,
    // and the run works in scratch space that dies with the scope.
    const branch = yield* repo === null
      ? Effect.succeed(null)
      : options
          .clone({ repo, targetDir: workspaceDir })
          .pipe(Effect.as(repo.branch));

    return {
      branch,
      globalArtifactsDir,
      projectArtifactsDir,
      runDir,
      strategy: "mount",
      taskArtifactsDir,
      workspaceDir,
    } satisfies RunWorkspace;
  });

  return Workspace.of({ materialize } satisfies WorkspaceInterface);
});

/**
 * The local materializer as a layer. Takes its clone rather than reaching for
 * one, so the wiring names which repo implementation a deployment runs — and so
 * a test can hand it one that writes a file.
 */
export const localWorkspaceLayer = (options: LocalWorkspaceOptions) =>
  Layer.effect(Workspace, makeLocalWorkspace(options));

/**
 * What a deployment runs: local directories, and checkouts cloned from the
 * host-side bare mirror by `./repo`.
 */
export const workspaceLayer = localWorkspaceLayer({
  clone: cloneIntoWorkspace,
});
