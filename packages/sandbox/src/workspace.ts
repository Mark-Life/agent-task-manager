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
 * **The agent home is checked, never created.** Every other mount source here
 * is made to exist; the provider's login directory is the one that must not be,
 * because an auto-created empty home starts a container that fails
 * authentication with a message no human can tell from an expired token. A
 * missing one is a `MountSourceMissing{purpose: "agent_home"}` naming the path
 * and the one-time login that fixes it.
 *
 * **The checkout dies with the scope; nothing else does.** A run's durable
 * output is a pushed branch or a file in the artifacts mount — anything left
 * only in the checkout was scratch, and keeping it would mean a data root that
 * grows by a repo per run. The run directory outlives the scope on purpose: the
 * transcript and the event ledger are read off it after the container is gone,
 * and the artifact folders outlive it because they are the point. So does the
 * package store: a cache released with the run is a cache that is cold every
 * time, which is the cost this whole mount exists to remove.
 */

import { join } from "node:path";
import type { RunId, SessionProvider } from "@workspace/domain";
import { agentHomeLoginHint, runDirOf } from "@workspace/harness";
import { Effect, Layer } from "effect";
import { FileSystem } from "effect/FileSystem";
import { type ArtifactLocation, ensureArtifactDir } from "./artifacts";
import { resolveCommitter } from "./committer";
import { composeSkillsScoped, type SkillScope } from "./composed-skills";
import { writeEnvFiles } from "./env-files";
import { type CloneFailed, MountSourceMissing } from "./errors";
import {
  eventLogDirOf,
  type MountPurpose,
  type MountSources,
  mountsFor,
  nestedMountPointsOf,
} from "./mounts";
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

/** Directory under the data root holding the package stores every run shares. */
export const CACHES_SEGMENT = "caches";

/** What names the shared package store on the host. */
export interface CachesDirInput {
  readonly dataRoot: string;
}

/**
 * The package store every run is handed, sibling to the checkouts.
 *
 * Under the same root as {@link workspaceDirOf} deliberately: pnpm hardlinks
 * out of its store into a checkout's `node_modules`, and a hardlink cannot cross
 * a filesystem. One root means the link works and the install is near instant;
 * two disks means pnpm silently copies instead.
 *
 * Nothing evicts from it. When the disk gets tight the answer is to delete the
 * directory and take one cold install, which is why there is no per-run or
 * per-project scoping to unpick first.
 */
export const cachesDirOf = (input: CachesDirInput) =>
  join(input.dataRoot, CACHES_SEGMENT);

/**
 * Mode for every directory a run is handed. The same value the artifact folders
 * get, for the same reason: what a run may and may not write is stated by the
 * mount's read-only flag, and a unix mode that disagreed with it would be a
 * second answer to a question the mount already settles.
 */
export const RUN_DIR_MODE = 0o755;

/**
 * Mode for the checkout, which is the one directory here that is narrower.
 *
 * A project's environment files are written into it, and the data root is one
 * directory a service account owns with every other run's checkout as a
 * sibling. The mount still decides what the run may do with it; this decides
 * what everything else on the host may do with it, which the mount says nothing
 * about.
 */
export const WORKSPACE_DIR_MODE = 0o700;

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
    readonly mode?: number;
    readonly path: string;
    readonly purpose: MountPurpose;
  }) =>
    fs
      .makeDirectory(input.path, {
        mode: input.mode ?? RUN_DIR_MODE,
        recursive: true,
      })
      .pipe(
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

  /**
   * The provider's login directory, checked and not made.
   *
   * The warning carries the one-time login line because this is the failure a
   * fresh host hits first, and the operator reading it has no other way to know
   * that the directory is theirs to create by hand.
   */
  const requireAgentHome = (input: {
    readonly agentHomeDir: string;
    readonly provider: SessionProvider;
  }) =>
    fs.exists(input.agentHomeDir).pipe(
      Effect.flatMap((present) =>
        present ? Effect.void : Effect.fail(new Error("absent"))
      ),
      Effect.tapError(() =>
        Effect.logWarning("agent home missing", {
          fix: agentHomeLoginHint(input.provider, input.agentHomeDir),
          path: input.agentHomeDir,
        })
      ),
      Effect.mapError(
        () =>
          new MountSourceMissing({
            hostPath: input.agentHomeDir,
            purpose: "agent_home",
          })
      ),
      Effect.as(input.agentHomeDir)
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
    const {
      agentHomeDir,
      dataRoot,
      identity,
      labels,
      projectId,
      repo,
      taskId,
    } = input;
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

    yield* requireAgentHome({ agentHomeDir, provider: input.provider });

    // Made, never released: the store is what the next run starts warm from, so
    // it is deliberately outside the `acquireRelease` below that takes the
    // checkout back.
    const cacheDir = yield* ensureMountSource({
      path: cachesDirOf({ dataRoot }),
      purpose: "cache",
    });

    const globalArtifactsDir = yield* ensureArtifacts({
      dataRoot,
      location: { scope: "global" },
      purpose: "global_artifacts",
    });
    const taskArtifactsDir = yield* ensureArtifacts({
      dataRoot,
      location: { scope: "task", taskId },
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
        mode: WORKSPACE_DIR_MODE,
        path: workspaceDirOf({ dataRoot, runId: identity.runId }),
        purpose: "workspace",
      }),
      releaseWorkspace
    );

    // The scopes of the tree, broadest first, which is the order the
    // composition resolves a repeated name in. Only the scopes this run really
    // has: a task with no project contributes no project level, exactly as it
    // mounts none.
    const skillScopes: readonly SkillScope[] = [
      { dir: globalArtifactsDir, level: "workspace" },
      ...(projectArtifactsDir === null
        ? []
        : [{ dir: projectArtifactsDir, level: "project" as const }]),
      { dir: taskArtifactsDir, level: "task" },
    ];
    // Scoped like the checkout, and for the same reason: it is derived from
    // durable sources, so keeping it would be keeping a stale copy of
    // something a person can already read where they wrote it.
    const composed = yield* composeSkillsScoped({
      agentHomeDir,
      dataRoot,
      runId: identity.runId,
      scopes: skillScopes,
      sharedSkillsDir: input.skillsDir,
    }).pipe(Effect.provideService(FileSystem, fs));

    const sources = {
      agentHomeDir,
      cacheDir,
      composedSkillsDir: composed.dir,
      globalArtifactsDir,
      labels,
      projectArtifactsDir,
      runDir,
      taskArtifactsDir,
      workspaceDir,
    } satisfies MountSources;

    // The scopes are bound at nested container paths, and a bind needs its
    // destination to already exist inside the parent's host directory. Docker
    // would make it through a writable parent, but the workspace scope is
    // read-only to a worker, so the daemon cannot — these are the directories
    // that make a read-only parent workable. Read off the mount set rather than
    // listed here, so nothing has to be remembered when the tree changes shape.
    //
    // The skills destination is dropped and the extras are absent, for one
    // reason: both of those nest inside the agent home, and that home is
    // checked and never created — making a directory inside it is making part
    // of it. It is mounted read-write, so the daemon creates the destination.
    //
    // What this leaves behind is an empty directory per level naming the level
    // below — a `worker/` inside the global folder, a task directory inside a
    // project folder. They hold nothing, and `scanArtifacts` drops directories,
    // so no artifact row ever comes of them.
    yield* Effect.forEach(
      nestedMountPointsOf(mountsFor(sources)).filter(
        (point) => point.purpose !== "skills"
      ),
      ensureMountSource,
      { discard: true }
    );

    // The seam. A repo means a fresh clone off the host-side mirror and a
    // branch to push; no repo means the empty directory is already the answer,
    // and the run works in scratch space that dies with the scope.
    const branch = yield* repo === null
      ? Effect.succeed(null)
      : options
          .clone({ repo, targetDir: workspaceDir })
          .pipe(Effect.as(repo.branch));

    // After the clone, never before: a clone fills an empty directory, and a
    // file already sitting where it is about to write is how `git clone` is
    // made to refuse the whole run. Inside the acquire's scope, so the one copy
    // of these secrets that exists in the clear is removed with the checkout on
    // every path the run can end on.
    const envFiles = yield* writeEnvFiles({
      files: input.envFiles,
      workspaceDir,
    }).pipe(Effect.provideService(FileSystem, fs));
    if (envFiles.paths.length > 0) {
      // Paths, never contents, and never a count of characters either: the log
      // says which files a run was given, which is the question an operator
      // debugging a failed dev server actually has.
      yield* Effect.logInfo("project env files written into the checkout", {
        excluded: envFiles.excluded,
        paths: envFiles.paths,
      });
    }

    return {
      ...sources,
      branch,
      envFiles,
      strategy: "mount",
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
 *
 * The committer is resolved here, at layer build, and closed over for the life
 * of the process. That is the only place it can be read once: the clone seam
 * answers with `Scope` alone and cannot ask a service who it is, and a lookup
 * inside the clone would put a GitHub request on the path of every dispatch for
 * an answer that cannot change while the loop runs. A build that cannot reach
 * GitHub still produces a materializer — {@link resolveCommitter} is total —
 * so this is never the reason a loop fails to boot.
 */
export const workspaceLayer = Layer.effect(
  Workspace,
  Effect.flatMap(resolveCommitter(), (committer) =>
    makeLocalWorkspace({
      clone: (input) => cloneIntoWorkspace({ ...input, committer }),
    })
  )
);
