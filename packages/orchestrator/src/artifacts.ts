/**
 * The artifact index of the folders a run can write, rebuilt from their
 * directories after every run.
 *
 * **Postgres holds an index, never bytes, and the index is a cache.** Every
 * column of an artifact row — path, size, extension, modified time — is read
 * off the filesystem, so the table holds nothing disk cannot say again. That is
 * what removes a whole class of consistency bug rather than managing it: there
 * is no reconciliation to write, no repair path to test and no drift to detect,
 * because the answer to "the index disagrees with the directory" is to run this
 * again. A design where the database held the only copy of a file's existence
 * would need every one of those things, and each of them is a place the two
 * copies can part company.
 *
 * **Deletions have to land, not only additions.** An agent that removes a draft
 * it replaced, or renames a file, leaves a row pointing at nothing — and a
 * dashboard listing a file that 404s on click is worse than one that lists
 * nothing, because it reads as a broken server rather than as a deleted file.
 * So the write is a replace: `ArtifactRepo.replaceTaskIndex` upserts what the
 * scan found and deletes every task-scoped row it did not, in one transaction.
 * A rescan is therefore idempotent by construction — the same directory
 * produces the same rows however many times it is read.
 *
 * **Two folders, because a run can now write two.** The task's own folder is one.
 * The project's is the other, and it is scanned for the same reason it was made
 * writable: a research run leaves a document the next task in the project reads,
 * and a document with no artifact row is invisible to the dashboard and to
 * `artifacts_list` — which is most of the point of having left it there. A run
 * with no project scans one folder and says so with a null.
 *
 * The folders are the ones on the host. The container sees the task scope with
 * the run's checkout nested inside it, but on disk the checkout is
 * `workspaces/<runId>`, a sibling of the artifacts tree rather than anything
 * under it, so a rescan walks what the run left in an artifacts folder and never
 * the repository it cloned. The `.git` a shared scope keeps its history in is
 * dropped by the scan's own skip list, so taking that history costs no rows.
 *
 * The global folder is still left alone. Every run in the workspace shares it, a
 * worker's mount of it is read-only, and rescanning it from one run's teardown
 * would let that run's ending rewrite the index of a folder it could not have
 * changed.
 */

import { ArtifactRepo } from "@workspace/db";
import type { ProjectId, RunId, TaskId, WorkspaceId } from "@workspace/domain";
import {
  projectArtifactsDirOf,
  scanArtifacts,
  taskArtifactsDirOf,
} from "@workspace/sandbox";
import { Effect } from "effect";
import {
  type DispatchContext,
  projectIdOf,
  taskIdOf,
  workspaceIdOf,
} from "./dispatch-context";
import { IngestFailed } from "./errors";

/** Which task's folder to rescan, and which run to credit the files to. */
export interface ArtifactRescanInput {
  /** Where the artifacts tree lives. The run directory's root, not the run's own. */
  readonly dataRoot: string;
  /**
   * The run that last touched these files. Provenance only: it is stamped on
   * every row the scan writes, including files an earlier run left untouched,
   * because a scan cannot tell which run wrote which byte and claiming
   * otherwise would be a provenance nobody could trust.
   *
   * Required, because a rescan is something a run's teardown does. A caller
   * with no run to name is repairing the index rather than recording a run, and
   * that is a different verb with a different audit story.
   */
  readonly runId: RunId;
  readonly taskId: TaskId;
  readonly workspaceId: WorkspaceId;
}

/** What one rescan found and wrote. */
export interface ArtifactRescanReport {
  /** The directory that was walked, so a surprising count names a path a human can `ls`. */
  readonly directory: string;
  /** Rows the index now holds for this folder. Files removed on disk are gone from it. */
  readonly indexed: number;
}

/** Which project's folder to rescan, and which run to credit the files to. */
export interface ProjectRescanInput {
  readonly dataRoot: string;
  readonly projectId: ProjectId;
  /** Stamped on every row, exactly as on a task's — see {@link ArtifactRescanInput.runId}. */
  readonly runId: RunId;
  readonly workspaceId: WorkspaceId;
}

/**
 * Every way a rescan can fail, as the one ingest failure named after the run
 * whose teardown it was. Shared by both scopes, so a directory that cannot be
 * walked reports the same thing whichever folder it was.
 */
const failingFor =
  (runId: RunId) =>
  <A, E, R>(effect: Effect.Effect<A, E, R>) =>
    Effect.mapError(
      effect,
      (cause) => new IngestFailed({ cause, runId, source: "artifacts" })
    );

/**
 * Rescans one task's artifacts directory and replaces its index rows.
 *
 * A directory that was never created scans to nothing and clears the index,
 * which is the right answer twice over: a task whose run wrote no artifact has
 * none, and a task whose folder was deleted by hand has none either.
 */
export const rescanTaskArtifacts = Effect.fn("Ingest.artifacts")(function* (
  input: ArtifactRescanInput
) {
  const directory = taskArtifactsDirOf({
    dataRoot: input.dataRoot,
    taskId: input.taskId,
  });
  yield* Effect.annotateCurrentSpan({ directory, taskId: input.taskId });

  const failing = failingFor(input.runId);
  const stats = yield* scanArtifacts(directory).pipe(failing);

  const artifacts = yield* ArtifactRepo;
  const rows = yield* artifacts
    .replaceTaskIndex({
      lastRunId: input.runId,
      stats,
      taskId: input.taskId,
      workspaceId: input.workspaceId,
    })
    .pipe(failing);

  yield* Effect.annotateCurrentSpan({ indexed: rows.length });
  return { directory, indexed: rows.length } satisfies ArtifactRescanReport;
});

/**
 * Rescans one project's artifacts directory and replaces its index rows.
 *
 * The rows a promotion wrote survive it. The upsert overwrites only what a
 * `stat` produced, so a promoted file keeps the stamp and the digest that say a
 * person decided it was worth sharing — a rescan that cleared those would turn
 * every run's teardown into an undo of somebody's decision.
 *
 * What does not survive is a row whose file is gone, promoted or not, and that
 * is the same rule the task folder follows for the same reason: a dashboard
 * listing a file that 404s reads as a broken server rather than as a deleted
 * file.
 */
export const rescanProjectArtifacts = Effect.fn("Ingest.projectArtifacts")(
  function* (input: ProjectRescanInput) {
    const directory = projectArtifactsDirOf({
      dataRoot: input.dataRoot,
      projectId: input.projectId,
    });
    yield* Effect.annotateCurrentSpan({
      directory,
      projectId: input.projectId,
    });

    const failing = failingFor(input.runId);
    const stats = yield* scanArtifacts(directory).pipe(failing);

    const artifacts = yield* ArtifactRepo;
    const rows = yield* artifacts
      .replaceProjectIndex({
        lastRunId: input.runId,
        projectId: input.projectId,
        stats,
        workspaceId: input.workspaceId,
      })
      .pipe(failing);

    yield* Effect.annotateCurrentSpan({ indexed: rows.length });
    return { directory, indexed: rows.length } satisfies ArtifactRescanReport;
  }
);

/** What a run's teardown rebuilt, one report per folder it could write. */
export interface RunRescanReport {
  /** Null for a task with no project, and for every conversation. */
  readonly project: ArtifactRescanReport | null;
  /** Null for a run attached to a conversation, which has no task folder. */
  readonly task: ArtifactRescanReport | null;
}

/**
 * The same rescans, addressed by the run that just finished. One reader of the
 * dispatch context, so the loop and any later caller cannot disagree about which
 * folders a run's teardown rebuilds.
 *
 * A run attached to a conversation rebuilds nothing and says so with two nulls:
 * it has no task folder and no project, because the board tools are how it
 * changes anything that outlives it.
 *
 * The two are separate reports rather than one number. The task's count is what
 * that run produced; the project's counts every file the folder holds, including
 * files earlier runs left, so adding them would be a measurement of the run that
 * grew every time somebody promoted something.
 *
 * A project folder that cannot be indexed is reported as a null beside a task
 * report that stands. The task's rows are already written by then, and failing
 * the pair would throw away a count the run earned over a folder it shares with
 * every other run on the project.
 */
export const rescanRunArtifacts = Effect.fnUntraced(function* (input: {
  readonly context: DispatchContext;
  readonly dataRoot: string;
}) {
  const { context, dataRoot } = input;
  const taskId = taskIdOf(context);
  if (taskId === null) {
    return { project: null, task: null } satisfies RunRescanReport;
  }
  const workspaceId = workspaceIdOf(context);
  const task = yield* rescanTaskArtifacts({
    dataRoot,
    runId: context.runId,
    taskId,
    workspaceId,
  });
  const projectId = projectIdOf(context);
  const project =
    projectId === null
      ? null
      : yield* rescanProjectArtifacts({
          dataRoot,
          projectId,
          runId: context.runId,
          workspaceId,
        }).pipe(
          Effect.tapError((cause) =>
            Effect.logWarning("project artifact rescan failed", { cause })
          ),
          Effect.orElseSucceed(() => null)
        );
  return { project, task } satisfies RunRescanReport;
});
