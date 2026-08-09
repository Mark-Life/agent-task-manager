/**
 * How much instruction text a run is about to be handed, measured before it is
 * handed it.
 *
 * Codex collects every `AGENTS.md` from the top of the tree down to the working
 * directory and spends **one combined budget, root first**. Past the budget the
 * remaining text is dropped, which means the deepest and most specific document
 * — the task's own brief, or the checkout's conventions — is the first thing to
 * go, and that is backwards from what a nested tree is for. The truncation is
 * silent to a headless caller: the only signal is a log line Codex writes at a
 * level `codex exec` filters out.
 *
 * So it is measured here, on the host, where a person who wrote the files can
 * see the number. Nothing is enforced and nothing is trimmed: a run over the
 * budget still runs, because guessing which of somebody's documents to drop is a
 * worse failure than the one being warned about.
 *
 * **The levels come from the mount set, not from a list.** A run's tree is
 * exactly the directories its container has under {@link
 * CONTAINER_WORKSPACE_DIR}, plus the ordinary directories between them, and both
 * agent CLIs read from the working directory upwards through all of it. Reading
 * the set is what keeps this correct for a manager turn, for a task with no
 * project and for a run with no checkout, none of which have the same depth.
 */

import { join } from "node:path";
import {
  INSTRUCTION_BUDGET_WARN_BYTES,
  INSTRUCTION_FILES,
} from "@workspace/domain";
import { Effect, Option } from "effect";
import { FileSystem } from "effect/FileSystem";
import { CONTAINER_WORKSPACE_DIR, isUnder, type Mount } from "./mounts";

/** One instruction file that exists, and what it costs. */
export interface InstructionFile {
  readonly bytes: number;
  /** The host path, which is the one a person can open. */
  readonly path: string;
}

/** What a run's whole tree of instruction files adds up to. */
export interface InstructionBudget {
  /** Root first, which is the order the budget is spent in. */
  readonly files: readonly InstructionFile[];
  /** True when the total has passed {@link INSTRUCTION_BUDGET_WARN_BYTES}. */
  readonly overBudget: boolean;
  readonly totalBytes: number;
}

/** The working directory of a run: the deepest thing mounted inside its tree. */
const cwdOf = (tree: readonly Mount[]) =>
  tree.reduce<string | null>(
    (deepest, mount) =>
      deepest === null || mount.containerPath.length > deepest.length
        ? mount.containerPath
        : deepest,
    null
  );

/**
 * Every container path from the top of the tree down to the working directory,
 * including the ordinary directories in between — `worker/` under the workspace
 * scope, `manager/` for a chat turn — which carry no mount of their own and are
 * still directories both CLIs walk through.
 */
const levelsOf = (cwd: string): readonly string[] => {
  const segments = cwd
    .slice(CONTAINER_WORKSPACE_DIR.length)
    .split("/")
    .filter((segment) => segment.length > 0);
  return [
    CONTAINER_WORKSPACE_DIR,
    ...segments.map((_, depth) =>
      join(CONTAINER_WORKSPACE_DIR, ...segments.slice(0, depth + 1))
    ),
  ];
};

/**
 * The host directory behind one container path: the deepest mount that covers
 * it, plus whatever of the path hangs below that mount's destination. The
 * inverse of the question `nestedMountPointsOf` asks.
 */
const hostPathOf = (containerPath: string, tree: readonly Mount[]) => {
  const [mount] = tree
    .filter(
      (candidate) =>
        candidate.containerPath === containerPath ||
        isUnder(containerPath, candidate.containerPath)
    )
    .sort((a, b) => b.containerPath.length - a.containerPath.length);
  return mount === undefined
    ? null
    : join(mount.hostPath, containerPath.slice(mount.containerPath.length));
};

/**
 * The host directories one run's instruction files can sit in, root first.
 *
 * Empty for a mount set with nothing in the tree — a container told to run a
 * shell has no scopes and reads no instructions.
 */
export const instructionDirsOf = (
  mounts: readonly Mount[]
): readonly string[] => {
  const tree = mounts.filter(
    (mount) =>
      mount.containerPath === CONTAINER_WORKSPACE_DIR ||
      isUnder(mount.containerPath, CONTAINER_WORKSPACE_DIR)
  );
  const cwd = cwdOf(tree);
  if (cwd === null) {
    return [];
  }
  return levelsOf(cwd)
    .map((level) => hostPathOf(level, tree))
    .filter((path) => path !== null);
};

/** The size of one file, or nothing where there is no file to read. */
const sizeOf = Effect.fnUntraced(function* (path: string) {
  const fs = yield* FileSystem;
  const info = yield* fs.stat(path).pipe(Effect.option);
  return Option.isSome(info) && info.value.type === "File"
    ? Option.some({
        bytes: Number(info.value.size),
        path,
      } satisfies InstructionFile)
    : Option.none<InstructionFile>();
});

/**
 * Measures what one run's tree of instruction files comes to, and says so when
 * it has grown past the budget.
 *
 * The warning is emitted here rather than left to the caller because there is
 * only one thing to do with the number, and a caller that forgot would leave the
 * truncation exactly as silent as Codex leaves it. It names the files as well as
 * the total: a total alone says a tree is too big, and the list says which
 * document to shorten.
 *
 * Directories that do not exist and files that were never written cost nothing
 * and appear nowhere — a run whose project has no conventions has no row for
 * them.
 */
export const measureInstructionBudget = Effect.fn("Instructions.measure")(
  function* (mounts: readonly Mount[]) {
    const candidates = instructionDirsOf(mounts).flatMap((dir) =>
      INSTRUCTION_FILES.map((name) => join(dir, name))
    );
    const found = yield* Effect.forEach(candidates, sizeOf);
    const files = found.filter(Option.isSome).map((file) => file.value);
    const totalBytes = files.reduce((sum, file) => sum + file.bytes, 0);
    const overBudget = totalBytes > INSTRUCTION_BUDGET_WARN_BYTES;

    yield* Effect.annotateCurrentSpan({ instructionBytes: totalBytes });
    if (overBudget) {
      yield* Effect.logWarning(
        "instruction files exceed the 32 KiB a default Codex truncates at, and it drops the deepest file first",
        {
          budgetBytes: INSTRUCTION_BUDGET_WARN_BYTES,
          files: files.map((file) => `${file.path} (${file.bytes} bytes)`),
          totalBytes,
        }
      );
    }
    return { files, overBudget, totalBytes } satisfies InstructionBudget;
  }
);
