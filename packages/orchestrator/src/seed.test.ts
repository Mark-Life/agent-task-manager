/**
 * What this file defends: the promise that a rule is editable without a
 * redeploy.
 *
 * Two halves, and the second is the one with teeth. A fresh install has to end
 * up with a document to edit, in both names each provider reads. An install
 * where somebody has edited one must come back from a boot with their words
 * still in it — a seeder that reconciled towards the shipped text would revert
 * an operator silently, which is worse than never having moved the text out of
 * the build.
 *
 * Real files in a temporary data root, no mocks: the whole behaviour under test
 * is what is on the disk afterwards.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BunFileSystem } from "@effect/platform-bun";
import {
  AGENTS_INSTRUCTIONS_FILE,
  ATM_ROOT_MARKER,
  CLAUDE_INSTRUCTIONS_FILE,
} from "@workspace/harness";
import {
  MANAGER_INSTRUCTIONS,
  WORKSPACE_INSTRUCTIONS,
} from "@workspace/prompts";
import { globalArtifactsDirOf, MANAGER_SEGMENT } from "@workspace/sandbox";
import { Effect } from "effect";
import type { FileSystem } from "effect/FileSystem";
import { seedInstructionFiles } from "./seed";

let dataRoot: string;

beforeEach(() => {
  dataRoot = mkdtempSync(join(tmpdir(), "seed-"));
});

afterEach(() => {
  rmSync(dataRoot, { force: true, recursive: true });
});

const run = <A, E>(program: Effect.Effect<A, E, FileSystem>) =>
  Effect.runPromise(program.pipe(Effect.provide(BunFileSystem.layer)));

const seed = () => run(seedInstructionFiles({ dataRoot }));

/** Where the workspace scope's own pair sits on the host. */
const workspaceScope = () => globalArtifactsDirOf(dataRoot);

/** Where the manager's pair sits: an ordinary directory inside that scope. */
const managerScope = () => join(workspaceScope(), MANAGER_SEGMENT);

const read = (dir: string, name: string) =>
  readFileSync(join(dir, name), "utf-8");

describe("a first boot", () => {
  test("writes both documents under both names, so each provider finds one", async () => {
    const written = await seed();

    expect(read(workspaceScope(), AGENTS_INSTRUCTIONS_FILE)).toBe(
      WORKSPACE_INSTRUCTIONS
    );
    expect(read(managerScope(), AGENTS_INSTRUCTIONS_FILE)).toBe(
      MANAGER_INSTRUCTIONS
    );
    expect(written).toHaveLength(4);
  });

  /**
   * Claude does not read `AGENTS.md` at all, and a copy of the text under the
   * second name is a second thing to keep in step. The import is what makes one
   * file serve both providers, and it is relative because an absolute host path
   * means nothing inside a container.
   */
  test("makes the Claude half an import of the text rather than a copy of it", async () => {
    await seed();
    for (const dir of [workspaceScope(), managerScope()]) {
      const claude = read(dir, CLAUDE_INSTRUCTIONS_FILE);
      expect(claude.trim()).toBe(`@${AGENTS_INSTRUCTIONS_FILE}`);
      expect(claude.startsWith("/")).toBe(false);
    }
  });

  /**
   * Codex stops its upward walk at the root marker and reads nothing above it,
   * so a tree seeded with rules but no marker is a tree that provider never
   * walks up into. The seeder asks for the folder the same way every other
   * caller does, which is what keeps the two together.
   */
  test("leaves the workspace scope with the marker that makes the walk reach it", async () => {
    await seed();
    expect(read(workspaceScope(), ATM_ROOT_MARKER)).toBe("");
  });

  test("creates the data root it was pointed at, having found nothing there", async () => {
    const written = await seed();
    for (const path of written) {
      expect(path.startsWith(dataRoot)).toBe(true);
    }
  });
});

describe("every boot after the first", () => {
  test("keeps an edited file, because reverting one is what this exists to prevent", async () => {
    await seed();
    const edited = "# House rules\n\nWrite in Dutch.\n";
    writeFileSync(join(workspaceScope(), AGENTS_INSTRUCTIONS_FILE), edited);

    const written = await seed();

    expect(read(workspaceScope(), AGENTS_INSTRUCTIONS_FILE)).toBe(edited);
    expect(written).toEqual([]);
  });

  test("reports nothing written when every file was already there", async () => {
    await seed();
    expect(await seed()).toEqual([]);
  });

  /**
   * A person may delete a file they do not want. Restoring only what is missing
   * is what makes the seeder safe to run on every boot: the deleted one comes
   * back, the edited one beside it is untouched.
   */
  test("restores only the file that is missing", async () => {
    await seed();
    const edited = "# The manager's rules\n\nAnswer in one word.\n";
    writeFileSync(join(managerScope(), AGENTS_INSTRUCTIONS_FILE), edited);
    rmSync(join(workspaceScope(), AGENTS_INSTRUCTIONS_FILE));

    const written = await seed();

    expect(written).toEqual([join(workspaceScope(), AGENTS_INSTRUCTIONS_FILE)]);
    expect(read(managerScope(), AGENTS_INSTRUCTIONS_FILE)).toBe(edited);
  });
});
