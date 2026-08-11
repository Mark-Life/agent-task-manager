/**
 * The directories a killed process left behind, and how to name them.
 *
 * The sibling of `./reap`, and the same shape on purpose: everything here lists
 * and removes, and nothing here decides. Whether a directory is an orphan is a
 * database question — three different ones — and they are asked by the
 * orchestrator's boot reconcile, which is the only party that can see both
 * sides. What this file owns is where to look, what a directory has to look like
 * to be considered at all, and the rule that a keep set nobody could produce
 * strands nothing.
 *
 * Four roots, three joins, and the joins are not interchangeable.
 *
 * **`runs/<runId>` is kept while a run *row* exists**, live or finished a month
 * ago. Not a liveness join, and that is the point: the transcript and the event
 * ledger are read off this directory after the container is gone, `run_event`
 * rows are clipped while the transcript on disk is the whole conversation at
 * full length, and the contract already promises it back over
 * `GET /tasks/:taskId/sessions/:sessionId/transcript`. So nothing here ages a
 * run directory out — a row is what keeps it, and the only directory this
 * removes is one whose row is gone. That happens: deleting a task cascades to
 * its runs, and until now nothing followed them onto disk.
 *
 * **`workspaces/<runId>` and `composed-skills/<runId>` are kept only while the
 * run is live.** Both are scratch by design, both are released when the run's
 * scope closes, and both are therefore left behind by exactly the ending a
 * release cannot survive. They take one join between them because they have one
 * lifetime between them. The checkout is the expensive half — a full repo clone
 * with the project's environment files written into it.
 *
 * **`mirrors/<host>/<owner>/<name>.git` is kept while any project or task still
 * names the repo.** A mirror is a cache, so a mirror removed and wanted again
 * costs the cold clone `./repo` already does on first use. The staging
 * directories a killed `clone --mirror` leaves are not swept: they do not end in
 * {@link MIRROR_SUFFIX}, and one of them can belong to a clone another loop has
 * in flight.
 *
 * **An unknown keep set strands nothing.** A set built from a read that failed
 * is a set missing entries, and every entry missing from it is a directory this
 * would delete — the failure mode of a sweep is not that it skips a boot, it is
 * that it removes a live run's checkout because the database was briefly
 * unreachable. So {@link strandedOf} takes a nullable set and answers with
 * nothing when it is null, and the caller passes null for exactly the reads it
 * could not complete.
 *
 * **A name that is not a run id is left alone.** The whole safety of the two
 * run-keyed roots is that a directory is removed only when it can be attributed
 * to a run, which is the same rule `./reap` applies to a container label.
 */

import { join } from "node:path";
import { parseRepoUrl, RunId } from "@workspace/domain";
import { runsRootOf } from "@workspace/harness";
import { Effect, Option, Schema } from "effect";
import { FileSystem } from "effect/FileSystem";
import { composedSkillsRootOf } from "./composed-skills";
import { MIRROR_SUFFIX, mirrorDirOf, mirrorsRootOf } from "./repo";
import { workspacesRootOf } from "./workspace";

/**
 * One directory a sweep is deciding about.
 *
 * The key is what the join is stated in, and it is a parameter because the two
 * kinds of key are asked about differently: a run id goes to the database as an
 * id, and a mirror is keyed by its own path, which is what {@link mirrorKeyOf}
 * reproduces from a repo url. Keeping the run id branded all the way to the
 * query is what stops a directory name from being handed to a `uuid` column
 * unchecked.
 */
export interface StrayDirectory<K extends string = string> {
  readonly key: K;
  readonly path: string;
}

/** A directory name read back as the run it belongs to, or nothing. */
const decodeRunId = Schema.decodeUnknownOption(RunId);

/**
 * What is directly under a directory, and nothing at all where there is no
 * directory to read.
 *
 * Silent about an absent root, because that is the ordinary case on a host that
 * has never cloned a repo or has just been provisioned — and a sweep that warned
 * about it would warn on every boot of a healthy install.
 */
const childrenOf = Effect.fnUntraced(function* (dir: string) {
  const fs = yield* FileSystem;
  return yield* fs
    .readDirectory(dir)
    .pipe(Effect.orElseSucceed(() => [] as string[]));
});

/** The children of `root` that are named after a run. Anything else is not ours. */
const runIdDirectoriesUnder = Effect.fnUntraced(function* (root: string) {
  const found: StrayDirectory<RunId>[] = [];
  for (const name of yield* childrenOf(root)) {
    const runId = decodeRunId(name);
    if (Option.isSome(runId)) {
      found.push({ key: runId.value, path: join(root, name) });
    }
  }
  return found as readonly StrayDirectory<RunId>[];
});

/** Every run directory on disk, whatever the database thinks of it. */
export const runDirectoriesOf = (dataRoot: string) =>
  runIdDirectoriesUnder(runsRootOf(dataRoot));

/** Every checkout on disk, whatever the database thinks of it. */
export const checkoutsOf = (dataRoot: string) =>
  runIdDirectoriesUnder(workspacesRootOf(dataRoot));

/** Every skills composition on disk. Same lifetime as a checkout, same join. */
export const compositionsOf = (dataRoot: string) =>
  runIdDirectoriesUnder(composedSkillsRootOf(dataRoot));

/**
 * Every bare mirror on disk.
 *
 * Walked to a fixed depth rather than listed recursively: a mirror is a
 * repository full of directories, and a recursive read would descend into
 * hundreds of thousands of loose objects to find nothing. The three levels are
 * host, owner and repo, which is what {@link mirrorDirOf} writes.
 */
export const mirrorsOf = Effect.fnUntraced(function* (dataRoot: string) {
  const root = mirrorsRootOf(dataRoot);
  const found: StrayDirectory[] = [];
  for (const host of yield* childrenOf(root)) {
    const hostDir = join(root, host);
    for (const owner of yield* childrenOf(hostDir)) {
      const ownerDir = join(hostDir, owner);
      for (const name of yield* childrenOf(ownerDir)) {
        if (name.endsWith(MIRROR_SUFFIX)) {
          const path = join(ownerDir, name);
          found.push({ key: path, path });
        }
      }
    }
  }
  return found as readonly StrayDirectory[];
});

/**
 * The mirror a repo url would be cloned into, or null when the url names no
 * repository this system could clone.
 *
 * The keep set is built out of this rather than out of a slug, so a mirror is
 * kept by the same path algebra that created it: one function decides where a
 * repo lives, and the sweep asks it rather than reconstructing the answer.
 */
export const mirrorKeyOf = (input: {
  readonly dataRoot: string;
  readonly repoUrl: string;
}) => {
  const repo = parseRepoUrl(input.repoUrl);
  return repo === null ? null : mirrorDirOf({ dataRoot: input.dataRoot, repo });
};

/**
 * The directories to remove, given everything on disk and the keys something
 * still owns.
 *
 * Pure, and separated from both sides for the reason the module note gives: one
 * half is a filesystem and the other is a database, and the rule joining them is
 * the only part worth testing. A null keep set is a read that did not complete,
 * and it strands nothing at all.
 */
export const strandedOf = <K extends string>(input: {
  readonly found: readonly StrayDirectory<K>[];
  readonly keep: ReadonlySet<string> | null;
}): readonly StrayDirectory<K>[] => {
  const { keep } = input;
  return keep === null ? [] : input.found.filter((dir) => !keep.has(dir.key));
};

/**
 * Removes what the join stranded, and answers with the paths that are actually
 * gone.
 *
 * A failure is logged and swallowed, like every teardown of something that has
 * already ended: a directory left behind is disk to reclaim on the next boot,
 * not a reason for a loop to refuse to start. The paths come back so the caller
 * can say what it reclaimed — a sweep that removes a repo clone and reports only
 * a count leaves an operator with no way to tell what it took.
 */
export const removeStrays = Effect.fnUntraced(function* (
  dirs: readonly StrayDirectory[]
) {
  const fs = yield* FileSystem;
  const removed: string[] = [];
  for (const dir of dirs) {
    const gone = yield* fs
      .remove(dir.path, { force: true, recursive: true })
      .pipe(
        Effect.tapError((cause) =>
          Effect.logWarning("stray directory not removed", {
            cause,
            path: dir.path,
          })
        ),
        Effect.as(true),
        Effect.orElseSucceed(() => false)
      );
    if (gone) {
      removed.push(dir.path);
    }
  }
  return removed as readonly string[];
});
