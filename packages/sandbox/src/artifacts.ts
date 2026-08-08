/**
 * The three artifact folders on the host, and the four things anyone does to
 * them: create, scan, copy, promote.
 *
 * An artifact is a file a run produced and someone wanted to keep. The storage
 * mechanism is a directory — the task's folder is bind-mounted read-write into
 * its container, and the agent writes to it with the same file tools it uses for
 * everything else. There is no `create_artifact` tool, because a model already
 * knows `Write` and every extra tool costs a little quality; the whole interface
 * is one line of prompt saying which directory survives the container.
 *
 * All three folders hang off one root. `<dataRoot>/artifacts/{global,
 * projects/<id>, tasks/<id>}` rather than an `artifacts` folder tucked under
 * each task and project: one root is one place to look, to back up and to scan,
 * and the alternative is a folder per task scattered through the data root.
 *
 * The host layout is flat and the container's is nested. A run sees the global
 * folder at `/workspace`, its project's inside that and its own inside that
 * again, because both agent CLIs read instruction files by walking up from the
 * working directory — see `./mounts`. Nothing here moves for it: a mount maps a
 * host path to a container path, and these paths are the host's.
 *
 * **Postgres holds an index, never bytes.** {@link scanArtifacts} reads path,
 * size, modified time and extension off the disk; the orchestrator writes those
 * rows. Because every field is derivable from the filesystem the table is a
 * cache rather than a source of truth, so drift is repaired by rescanning
 * instead of reconciled. Bytes stay on disk: reading a file from local disk is a
 * page-cache hit, reading it from Postgres is a round-trip plus decompression of
 * a large value, and large values bloat the write-ahead log and every backup
 * forever.
 *
 * **Reuse is a copy, never a reference.** {@link copyArtifact} duplicates the
 * bytes, and that is deliberate: if task B pointed at task A's file and A were
 * later refined, B's record of what it actually worked from would become
 * retroactively false — the evidence would change under the conclusion drawn
 * from it. Disk is cheap; a task folder that is a self-contained record of what
 * that task saw is worth more than deduplication. `contentHash` on the copy is
 * what lets the two rows be compared later.
 *
 * **No versioning.** A folder of current files. What a previous draft said is in
 * the run transcript. If real history ever matters the answer is `git init` in
 * the artifacts directory and a commit after each run — free history, free diff,
 * tooling everyone knows, and no schema — which is exactly why there is no
 * version table here to migrate away from. {@link SCAN_SKIP_DIRS} keeps that
 * option free by leaving `.git` out of the index in advance.
 */

import { createHash } from "node:crypto";
import { dirname, extname, join, sep } from "node:path";
import type { ArtifactStat, ProjectId, TaskId } from "@workspace/domain";
import { ATM_ROOT_MARKER } from "@workspace/harness";
import { DateTime, Effect, Option, Schema } from "effect";
import { FileSystem } from "effect/FileSystem";

/** The single root the three folders hang off, and the manager's search mount. */
export const ARTIFACTS_SEGMENT = "artifacts";

/** The folder shared by every task in every project. */
export const GLOBAL_SEGMENT = "global";

/** Parent of the per-project promoted folders. */
export const PROJECTS_SEGMENT = "projects";

/** Parent of the per-task folders. */
export const TASKS_SEGMENT = "tasks";

/**
 * Mode for every artifact directory, all three scopes alike.
 *
 * Which scope a run may write is enforced by the mount's read-only flag, not by
 * the unix mode, and that is on purpose: every folder here has to be writable by
 * the uid the container runs as — a worker writes its task folder and its
 * project folder, and a manager writes the global one — so a mode that differed
 * per scope would be a second, weaker copy of a rule the mount already states
 * exactly. One mode keeps the whole difference between roles in one place.
 */
export const ARTIFACT_DIR_MODE = 0o755;

/**
 * Directories the index skips. `.git` because the versioning story is "run
 * `git init` here if you ever want history" — indexing an object store would
 * turn that free option into thousands of meaningless rows the day someone took
 * it.
 */
export const SCAN_SKIP_DIRS = [".git"] as const;

/**
 * The hash a copy records, prefixed with the algorithm that produced it. The
 * prefix is what lets the algorithm change later without every stored value
 * becoming ambiguous.
 */
export const CONTENT_HASH_ALGORITHM = "sha256";

/** What an artifact operation was doing when the filesystem refused. Bounded, so it can be a metric tag. */
export const ARTIFACT_OPERATIONS = ["copy", "create", "read", "scan"] as const;

/** Which operation failed. */
export const ArtifactOperation = Schema.Literals(ARTIFACT_OPERATIONS);
export type ArtifactOperation = typeof ArtifactOperation.Type;

/**
 * The host filesystem refused an artifact operation: no space, no permission,
 * a path that is a file where a directory belongs.
 *
 * Its own error rather than a `SandboxError` because most of these happen
 * nowhere near a container — a promotion runs on the host from the gateway, and
 * calling that a sandbox failure would put a row in the ledger claiming a
 * container broke. {@link ./workspace} translates it where a run really is
 * about to start and the mount purpose is known.
 */
export class ArtifactIoFailed extends Schema.TaggedErrorClass<ArtifactIoFailed>()(
  "Artifacts.IoFailed",
  {
    cause: Schema.Unknown,
    operation: ArtifactOperation,
    path: Schema.String,
  }
) {}

/** Names what was being done to which path when the filesystem failed. */
const failing = (operation: ArtifactOperation, path: string) =>
  Effect.mapError(
    (cause: unknown) => new ArtifactIoFailed({ cause, operation, path })
  );

/** The root of every artifact folder, and the only thing a search mount needs. */
export const artifactsRootOf = (dataRoot: string) =>
  join(dataRoot, ARTIFACTS_SEGMENT);

/** The folder every run in the workspace can read. */
export const globalArtifactsDirOf = (dataRoot: string) =>
  join(artifactsRootOf(dataRoot), GLOBAL_SEGMENT);

/** Which project's promoted folder. */
export interface ProjectArtifactsInput {
  readonly dataRoot: string;
  readonly projectId: ProjectId;
}

/**
 * A project's promoted folder: the project scope of every run on it, mounted
 * read-write, so a promotion and a run leaving a document for the next task both
 * land here.
 */
export const projectArtifactsDirOf = (input: ProjectArtifactsInput) =>
  join(artifactsRootOf(input.dataRoot), PROJECTS_SEGMENT, input.projectId);

/** Which task's own folder. */
export interface TaskArtifactsInput {
  readonly dataRoot: string;
  readonly taskId: TaskId;
}

/** A task's own folder: this run's output, and the innermost scope of its tree. */
export const taskArtifactsDirOf = (input: TaskArtifactsInput) =>
  join(artifactsRootOf(input.dataRoot), TASKS_SEGMENT, input.taskId);

/**
 * Where an artifact lives, as a tagged union rather than a scope plus three
 * nullable ids. A project row without a project id and a task row with one are
 * both unrepresentable here, which is the difference between validating the
 * combination and never forming it.
 */
export type ArtifactLocation =
  | { readonly scope: "global" }
  | { readonly projectId: ProjectId; readonly scope: "project" }
  | { readonly scope: "task"; readonly taskId: TaskId };

/** A folder named by scope, under one data root. */
export interface ArtifactDirInput {
  readonly dataRoot: string;
  readonly location: ArtifactLocation;
}

/** Which host directory a location resolves to. Total over the three scopes. */
export const artifactDirOf = (input: ArtifactDirInput) => {
  const { dataRoot, location } = input;
  switch (location.scope) {
    case "global":
      return globalArtifactsDirOf(dataRoot);
    case "project":
      return projectArtifactsDirOf({ dataRoot, projectId: location.projectId });
    default:
      return taskArtifactsDirOf({ dataRoot, taskId: location.taskId });
  }
};

/** Creates one directory, or leaves an existing one alone. */
const ensureDir = Effect.fnUntraced(function* (path: string) {
  const fs = yield* FileSystem;
  yield* fs
    .makeDirectory(path, { mode: ARTIFACT_DIR_MODE, recursive: true })
    .pipe(failing("create", path));
  return path;
});

/**
 * Puts the empty {@link ATM_ROOT_MARKER} in the global folder, which is the top
 * of every run's instruction tree.
 *
 * Here rather than at either materialization site, because both of them go
 * through this module for that folder and a marker written by only one of them
 * is a Codex chat turn, or a Codex worker run, silently reading the one
 * `AGENTS.md` in its working directory — Codex stops its upward walk at the
 * first `project_root_markers` hit and reads nothing at all above the working
 * directory when there is none. The harness points that setting at this name on
 * every Codex turn, so the file not being there is worse than the default it
 * replaced.
 *
 * Written once and never rewritten: the content carries nothing, and a
 * whole-file write per run into a folder every other container has mounted is a
 * race for no gain.
 */
const ensureRootMarker = Effect.fnUntraced(function* (dir: string) {
  const fs = yield* FileSystem;
  const path = join(dir, ATM_ROOT_MARKER);
  const present = yield* fs.exists(path).pipe(failing("create", path));
  if (present) {
    return;
  }
  yield* fs.writeFileString(path, "").pipe(failing("create", path));
});

/**
 * Creates one artifact folder, on demand, and answers with its path.
 *
 * On demand rather than at task creation, because most tasks never write an
 * artifact at all and pre-creating a folder per task fills the tree with empty
 * directories that make "which tasks produced something" unanswerable from
 * disk. The global folder goes through here too: nothing else in a run's life
 * would create it, and the first run on a fresh host would die on a mount
 * source that does not exist.
 *
 * That folder also leaves with its root marker, because it is not only a folder
 * — it is the workspace scope every run's tree hangs off. See
 * {@link ensureRootMarker}.
 *
 * One folder per call rather than all three at once, so the caller that is
 * about to mount them can say which mount each failure was for — `./workspace`
 * translates a failure here into a `Sandbox.MountSourceMissing` naming the
 * purpose, and a batched call would only be able to name a path.
 */
export const ensureArtifactDir = Effect.fn("Artifacts.ensureDir")(function* (
  input: ArtifactDirInput
) {
  const dir = yield* ensureDir(artifactDirOf(input));
  if (input.location.scope === "global") {
    yield* ensureRootMarker(dir);
  }
  return dir;
});

/**
 * The extension a dashboard picks a renderer from: lowercase, no dot, and null
 * where there is none. A dotfile has no extension by this reading, which is
 * what `.gitignore` should be — a name, not a file of type `gitignore`.
 */
export const extOf = (path: string) => {
  const ext = extname(path);
  return ext === "" ? null : ext.slice(1).toLowerCase();
};

/** Whether a relative path passes through a directory the index ignores. */
const isSkipped = (relativePath: string) =>
  relativePath
    .split(sep)
    .some((segment) => SCAN_SKIP_DIRS.includes(segment as never));

/**
 * Reads one file's index row, or nothing if it cannot be read.
 *
 * A dangling symlink and a file deleted between the listing and the stat both
 * fail here, and neither should cost the other four hundred rows in the
 * directory — the index is a cache, so a missing row is repaired by the next
 * rescan while a failed scan leaves the whole task unindexed. The loss is
 * logged rather than silent.
 *
 * `stat` follows symlinks, so a link is indexed with its target's size and
 * time. That is what a reader of the file would get, which is the question the
 * index answers.
 */
const statArtifact = Effect.fnUntraced(function* (input: {
  readonly relativePath: string;
  readonly root: string;
}) {
  const fs = yield* FileSystem;
  const absolute = join(input.root, input.relativePath);
  const info = yield* fs.stat(absolute).pipe(
    Effect.tapError((cause) =>
      Effect.logWarning("artifact not indexed", { cause, path: absolute })
    ),
    Effect.option
  );
  if (Option.isNone(info) || info.value.type !== "File") {
    return Option.none<ArtifactStat>();
  }
  const now = yield* DateTime.now;
  return Option.some({
    bytes: Number(info.value.size),
    ext: extOf(input.relativePath),
    // Falls back to creation time and then to the scan's own clock. An absent
    // mtime is exotic enough that dropping the file would hide it entirely,
    // and a row with a suspicious timestamp is a row someone can still find.
    modifiedAt: Option.match(
      Option.orElse(info.value.mtime, () => info.value.birthtime),
      { onNone: () => now, onSome: DateTime.fromDateUnsafe }
    ),
    path: input.relativePath,
  } satisfies ArtifactStat);
});

/**
 * Walks an artifact directory and returns the index rows for what is in it.
 *
 * Run after each run against the task's folder. The rows go to Postgres, which
 * is the orchestrator's job — this returns them rather than writing them, so
 * the scan has no database in its dependencies and can be tested against a
 * temp directory.
 *
 * A directory that does not exist scans to nothing rather than failing: a run
 * that wrote no artifact is the common case, not an error, and the folder is
 * created on demand.
 *
 * Sorted by path, so two scans of an unchanged directory produce identical
 * output and a diff between them is a real change.
 */
export const scanArtifacts = Effect.fn("Artifacts.scan")(function* (
  root: string
) {
  const fs = yield* FileSystem;
  const present = yield* fs.exists(root).pipe(failing("scan", root));
  if (!present) {
    return [] as readonly ArtifactStat[];
  }
  const entries = yield* fs
    .readDirectory(root, { recursive: true })
    .pipe(failing("scan", root));
  const kept = entries.filter((entry) => !isSkipped(entry));
  const stats = yield* Effect.forEach(kept, (relativePath) =>
    statArtifact({ relativePath, root })
  );
  const rows = stats.filter(Option.isSome).map((stat) => stat.value);
  yield* Effect.annotateCurrentSpan({ fileCount: rows.length });
  return rows.sort((left, right) =>
    left.path.localeCompare(right.path)
  ) as readonly ArtifactStat[];
});

/** One file inside one artifact folder. */
export interface ArtifactRef {
  /** The scope root, from {@link artifactDirOf}. */
  readonly dir: string;
  /** Relative to `dir`. The natural key of an artifact row. */
  readonly path: string;
}

/**
 * What a copy produced: the index row of the new file, plus the hash of the
 * bytes it was made from. The hash exists only at this moment — a rescan does
 * not compute one, because size and modified time already answer "has this
 * changed", and hashing every file on every scan would read the whole tree to
 * learn nothing more.
 */
export interface ArtifactCopy extends ArtifactStat {
  readonly contentHash: string;
}

/** Where a file comes from and where it goes. */
export interface CopyArtifactInput {
  readonly from: ArtifactRef;
  readonly to: ArtifactRef;
}

/**
 * Copies one artifact between folders, bytes and all.
 *
 * The bytes are the point. A reference would make one task's record of what it
 * worked from mutable by another task's later edit, so the file a task saw is
 * the file that stays in its folder. The hash is recorded here because here is
 * where "these two rows are the same bytes" is still knowable for free — the
 * bytes are already in memory to be written.
 */
export const copyArtifact = Effect.fn("Artifacts.copy")(function* (
  input: CopyArtifactInput
) {
  const fs = yield* FileSystem;
  const source = join(input.from.dir, input.from.path);
  const target = join(input.to.dir, input.to.path);

  const bytes = yield* fs.readFile(source).pipe(failing("read", source));
  yield* fs
    .makeDirectory(dirname(target), {
      mode: ARTIFACT_DIR_MODE,
      recursive: true,
    })
    .pipe(failing("create", target));
  yield* fs.writeFile(target, bytes).pipe(failing("copy", target));

  const stat = yield* statArtifact({
    relativePath: input.to.path,
    root: input.to.dir,
  });
  const digest = createHash(CONTENT_HASH_ALGORITHM).update(bytes).digest("hex");
  const contentHash = `${CONTENT_HASH_ALGORITHM}:${digest}`;
  return yield* Option.match(stat, {
    // The write succeeded and the file is unreadable a line later: a full disk
    // reported late, or something outside the run deleting under it. Reporting
    // the bytes we wrote and this instant would be a row about a file that is
    // not there.
    onNone: () =>
      Effect.fail(
        new ArtifactIoFailed({
          cause: "copied file could not be stat'd",
          operation: "copy",
          path: target,
        })
      ),
    onSome: (row) =>
      Effect.succeed({ ...row, contentHash } satisfies ArtifactCopy),
  });
});

/** The two folders a task's file can be promoted into. Never another task's. */
export type PromotionTarget =
  | { readonly scope: "global" }
  | { readonly projectId: ProjectId; readonly scope: "project" };

/** Which of a task's files is being promoted, and to where. */
export interface PromoteArtifactInput {
  readonly dataRoot: string;
  /** Relative to the task's folder. Kept as the path in the target folder. */
  readonly path: string;
  readonly taskId: TaskId;
  readonly to: PromotionTarget;
}

/**
 * Promotes one of a task's artifacts into the project's folder or the global
 * one.
 *
 * A verb of its own rather than a flag on a row, and it survives the project
 * scope becoming writable to a run. It is still the only way into the global
 * folder, which no worker may write. Into a project's folder it is now one of
 * two ways, and the difference is who decided: a promotion is a person or a
 * manager saying this file is worth keeping, where a run's own write is a side
 * effect of the work. Attribution never rested on the mount flag — the artifact
 * row carries the run that last touched it, and a copy records its sha256.
 *
 * The audit row and the `promotedAt` stamp belong to whoever called this: the
 * decision is theirs, and the same copy performed by the machinery would not be
 * a promotion.
 */
export const promoteArtifact = Effect.fn("Artifacts.promote")(function* (
  input: PromoteArtifactInput
) {
  const to = yield* ensureArtifactDir({
    dataRoot: input.dataRoot,
    location: input.to,
  });
  yield* Effect.annotateCurrentSpan({ scope: input.to.scope });
  return yield* copyArtifact({
    from: {
      dir: taskArtifactsDirOf({
        dataRoot: input.dataRoot,
        taskId: input.taskId,
      }),
      path: input.path,
    },
    to: { dir: to, path: input.path },
  });
});
