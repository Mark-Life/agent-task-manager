/**
 * The comment a run could not post, read back off the disk it could reach.
 *
 * **The fallback of last resort, and the only one that survives losing the
 * board entirely.** A run has three ways to get its words onto the card, and
 * they degrade in order: it posts a comment itself; failing that the loop posts
 * its final assistant message; failing *that* — because a final message is only
 * as good as what the model chose to put in it, and a model that has spent an
 * hour being refused often ends with an apology rather than the work — the loop
 * reads {@link HANDOFF_FILENAME} out of the task's own artifacts directory.
 *
 * That directory is the one thing a worker keeps when everything else goes.
 * It is a bind mount on the host, so a file written into it is already outside
 * the container before the container dies, and it needs no credential, no
 * network and no tool the agent does not already have. Which is why the
 * instruction in `@workspace/prompts` is "write the file" rather than "retry
 * the tool": a retry needs the thing that is broken.
 *
 * **The file is not deleted after it is read.** The rescan indexes it as an
 * artifact in the same teardown, so it stays visible on the task as a file as
 * well as readable as a comment, and a re-ingest weeks later reads the same
 * bytes. A run that posts the handoff and is then rerun would re-post a stale
 * one, which is the cost accepted here: a duplicate comment naming its own
 * source is a line a reader skips, and deleting a run's only surviving output
 * to prevent it is the trade in the wrong direction.
 */

import { join } from "node:path";
import { HANDOFF_FILENAME, type TaskId } from "@workspace/domain";
import { taskArtifactsDirOf } from "@workspace/sandbox";
import { Effect, Option } from "effect";
import { FileSystem } from "effect/FileSystem";

/** Whose handoff to look for, and where the artifacts tree lives. */
export interface HandoffInput {
  /** The run directory's root, not the run's own — the artifact folders are its siblings. */
  readonly dataRoot: string;
  readonly taskId: TaskId;
}

/** A handoff that was there, and the path it was at. */
export interface Handoff {
  /** The file's contents, whole. The caller owns the clip, because it owns the budget. */
  readonly body: string;
  /** Where it was read from, so the comment can say where the rest of it is. */
  readonly path: string;
}

/** Where a task's handoff would be if it wrote one. */
export const handoffPathOf = (input: HandoffInput) =>
  join(
    taskArtifactsDirOf({ dataRoot: input.dataRoot, taskId: input.taskId }),
    HANDOFF_FILENAME
  );

/**
 * The run's handoff, or null where there is nothing to attach.
 *
 * Total over a missing or unreadable file, and that is the design rather than
 * laziness: this runs on the teardown path of a run that has already ended, and
 * most runs write no handoff at all because most runs never lose the board. A
 * failure here would turn "there was nothing to collect" into a run that failed
 * to close.
 *
 * A file of nothing but whitespace reads as absent. An agent that created the
 * file and then wrote its comment through the tool after all leaves an empty
 * one behind, and a blank comment on the card is worse than no comment: it
 * reads as a run that had nothing to say.
 */
export const readHandoff = Effect.fn("Ingest.handoff")(function* (
  input: HandoffInput
) {
  const fs = yield* FileSystem;
  const path = handoffPathOf(input);
  yield* Effect.annotateCurrentSpan({ path, taskId: input.taskId });

  const present = yield* fs
    .exists(path)
    .pipe(Effect.orElseSucceed(() => false));
  if (!present) {
    return null;
  }

  const contents = yield* Effect.option(fs.readFileString(path));
  if (Option.isNone(contents)) {
    yield* Effect.logWarning("handoff present but unreadable", { path });
    return null;
  }

  const body = contents.value;
  return body.trim().length === 0 ? null : ({ body, path } satisfies Handoff);
});
