/**
 * The rules a person may edit, put on disk once so there is something to edit.
 *
 * The workspace scope is the top of every run's instruction tree, and both agent
 * CLIs read it before they read a word of a prompt. Nothing puts a document
 * there on its own: a fresh data root has an empty global artifacts folder, so
 * without this step the first run of a new install reads no house style at all
 * and the promise that a rule is editable without a redeploy has no file behind
 * it.
 *
 * **Write if absent, never overwrite.** A person who edits a seeded file must
 * still have their edit there on the next boot, which is the entire point of
 * moving the text out of the build. So the seed is a default rather than a
 * desired state: a file that exists is a decision somebody made, and this runs
 * on every boot precisely because it is safe to.
 *
 * The consequence is worth stating, because it is the trade: a later release
 * that improves the seeded wording reaches no install that already booted once.
 * That is the same bargain as any dotfile, and the alternative — reconciling
 * towards the shipped text — reverts an operator's edit silently, which is the
 * failure this exists to prevent.
 *
 * The text comes from `@workspace/prompts` rather than from a literal here, so
 * the copy written to disk and the copy a local turn is handed in its prompt are
 * one constant. A second spelling in this file would drift the day either
 * changed.
 *
 * Both documents are written twice under two names. Claude reads `CLAUDE.md` and
 * not `AGENTS.md`; Codex reads `AGENTS.md` and not `CLAUDE.md`. The text lives in
 * the `AGENTS.md` and the `CLAUDE.md` is one import line pointing at it, so
 * there is one file to edit and no pair to keep in step.
 */

import { join } from "node:path";
import {
  AGENTS_INSTRUCTIONS_FILE,
  CLAUDE_INSTRUCTIONS_FILE,
  CLAUDE_INSTRUCTIONS_IMPORT,
} from "@workspace/harness";
import {
  MANAGER_INSTRUCTIONS,
  WORKSPACE_INSTRUCTIONS,
} from "@workspace/prompts";
import {
  ARTIFACT_DIR_MODE,
  ensureArtifactDir,
  MANAGER_SEGMENT,
} from "@workspace/sandbox";
import { Effect } from "effect";
import { FileSystem } from "effect/FileSystem";

/** One seeded document, and the directory of the tree it is the rules for. */
interface SeededDocument {
  /** The text, which goes in the `AGENTS.md`. */
  readonly body: string;
  /** Absolute host path of the directory holding the pair. */
  readonly directory: string;
}

/** Which install to seed. */
export interface SeedInstructionsInput {
  /** The data root the artifact folders hang off. */
  readonly dataRoot: string;
}

/**
 * Writes one file unless it is already there, and answers with whether it wrote.
 *
 * The check and the write are two operations with a gap between them, and that
 * is acceptable here for a reason rather than by omission: the only writers of
 * these paths are one boot of one loop and a person with an editor, so the race
 * that would matter — two loops booting into one data root at the same instant —
 * ends with both writing identical bytes.
 */
const writeIfAbsent = Effect.fnUntraced(function* (input: {
  readonly body: string;
  readonly path: string;
}) {
  const fs = yield* FileSystem;
  const present = yield* fs.exists(input.path);
  if (present) {
    return false;
  }
  yield* fs.writeFileString(input.path, input.body);
  return true;
});

/**
 * Seeds the instruction files into the workspace scope, and answers with the
 * paths it actually created — which is every one of them on a fresh install and
 * none of them on the next boot.
 *
 * The global artifacts folder is created through {@link ensureArtifactDir}
 * rather than directly, because that is what also writes the root marker Codex
 * stops its upward walk at. A tree seeded with rules that Codex never walks up
 * to is the failure of this whole arrangement, and asking for the folder the way
 * every other caller does is what keeps the two from being separable.
 *
 * Fails rather than swallows: the caller at boot decides what a filesystem that
 * refuses is worth, and a loop that cannot write its own data root has more
 * wrong with it than its house rules.
 */
export const seedInstructionFiles = Effect.fn("Instructions.seed")(function* (
  input: SeedInstructionsInput
) {
  const fs = yield* FileSystem;
  const workspaceScope = yield* ensureArtifactDir({
    dataRoot: input.dataRoot,
    location: { scope: "global" },
  });

  const documents: readonly SeededDocument[] = [
    { body: WORKSPACE_INSTRUCTIONS, directory: workspaceScope },
    {
      body: MANAGER_INSTRUCTIONS,
      // An ordinary directory inside the workspace scope's folder rather than a
      // mount of its own, which is why it is made here: a manager turn's own
      // rules arrive through the bind that is already there.
      directory: join(workspaceScope, MANAGER_SEGMENT),
    },
  ];

  const written: string[] = [];
  for (const document of documents) {
    yield* fs.makeDirectory(document.directory, {
      mode: ARTIFACT_DIR_MODE,
      recursive: true,
    });
    const pair = [
      { body: document.body, name: AGENTS_INSTRUCTIONS_FILE },
      { body: CLAUDE_INSTRUCTIONS_IMPORT, name: CLAUDE_INSTRUCTIONS_FILE },
    ];
    for (const file of pair) {
      const path = join(document.directory, file.name);
      const created = yield* writeIfAbsent({ body: file.body, path });
      if (created) {
        written.push(path);
      }
    }
  }

  yield* Effect.annotateCurrentSpan({ seeded: written.length });
  return written as readonly string[];
});
