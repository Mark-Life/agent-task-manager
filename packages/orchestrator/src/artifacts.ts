/**
 * The task's artifact index, rebuilt from its directory after every run.
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
 * Only the task's own folder is scanned. The project and global folders are
 * mounted read-only into every container precisely so a run cannot write them;
 * their rows change when somebody promotes a file, which is a deliberate act
 * with an audit row of its own, and rescanning them here would let a run's
 * teardown quietly rewrite shared state.
 */

import { ArtifactRepo } from "@workspace/db";
import type { RunId, TaskId, WorkspaceId } from "@workspace/domain";
import { scanArtifacts, taskArtifactsDirOf } from "@workspace/sandbox";
import { Effect } from "effect";
import {
  type DispatchContext,
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
  /** Rows the index now holds for this task. Files removed on disk are gone from it. */
  readonly indexed: number;
}

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

  const failing = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
    Effect.mapError(
      effect,
      (cause) =>
        new IngestFailed({ cause, runId: input.runId, source: "artifacts" })
    );

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
 * The same rescan, addressed by the run that just finished. One reader of the
 * dispatch context, so the loop and any later caller cannot disagree about
 * which task's folder a run's teardown rebuilds.
 *
 * A run attached to a conversation rescans nothing and says so with a null: it
 * has no task folder, because the board tools are how it changes anything that
 * outlives it.
 */
export const rescanRunArtifacts = (input: {
  readonly context: DispatchContext;
  readonly dataRoot: string;
}) => {
  const taskId = taskIdOf(input.context);
  return taskId === null
    ? Effect.succeed(null)
    : rescanTaskArtifacts({
        dataRoot: input.dataRoot,
        runId: input.context.runId,
        taskId,
        workspaceId: workspaceIdOf(input.context),
      });
};
