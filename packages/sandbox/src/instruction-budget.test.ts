/**
 * What this file defends: a run whose instruction files have outgrown the
 * budget is a run somebody is told about, and the levels counted are the ones
 * that run actually walks.
 *
 * The second half is the one that goes wrong quietly. Codex spends its budget
 * root first and drops the deepest document, which is the task's own brief —
 * so a measurement that missed a level, or counted a level the run never sees,
 * would put a number on the row that answers a different question than the one
 * anybody asks of it.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BunFileSystem } from "@effect/platform-bun";
import { INSTRUCTION_BUDGET_WARN_BYTES } from "@workspace/domain";
import { Effect } from "effect";
import {
  instructionDirsOf,
  measureInstructionBudget,
} from "./instruction-budget";
import {
  type MountSources,
  managerMountsFor,
  mountsFor,
  NO_MOUNT_EXTRAS,
} from "./mounts";

let root: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "instructions-"));
});

afterEach(() => {
  rmSync(root, { force: true, recursive: true });
});

/** A host directory under the temporary root, made on demand. */
const dir = (name: string) => {
  const path = join(root, name);
  mkdirSync(path, { recursive: true });
  return path;
};

/** The mount sources of a worker run on a project, over real directories. */
const sourcesOf = (): MountSources => ({
  agentHomeDir: dir("agent-home"),
  cacheDir: dir("cache"),
  composedSkillsDir: null,
  globalArtifactsDir: dir("global"),
  labels: { project: "Atlas", repo: "owner/atlas", task: "Ship the thing" },
  projectArtifactsDir: dir("project"),
  runDir: dir("run"),
  taskArtifactsDir: dir("task"),
  workspaceDir: dir("checkout"),
});

/** Writes an `AGENTS.md` of a given size into a directory of the tree. */
const writeInstructions = (path: string, bytes: number) => {
  mkdirSync(path, { recursive: true });
  writeFileSync(join(path, "AGENTS.md"), "x".repeat(bytes));
};

const measure = (mounts: Parameters<typeof measureInstructionBudget>[0]) =>
  Effect.runPromise(
    measureInstructionBudget(mounts).pipe(Effect.provide(BunFileSystem.layer))
  );

describe("the levels a run's tree is counted over", () => {
  test("names every host directory from the workspace scope down to the checkout", () => {
    const sources = sourcesOf();

    const dirs = instructionDirsOf(mountsFor(sources));

    expect(dirs).toEqual([
      sources.globalArtifactsDir,
      join(sources.globalArtifactsDir, "worker"),
      sources.projectArtifactsDir as string,
      sources.taskArtifactsDir,
      sources.workspaceDir,
    ]);
  });

  /**
   * The manager's own rules sit in an ordinary directory inside the workspace
   * bind rather than in a mount, so a measurement that only read the mount set
   * would miss exactly the document a manager turn is given.
   */
  test("includes the directories between two mounts, which carry no mount of their own", () => {
    const sources = sourcesOf();

    const dirs = instructionDirsOf(
      managerMountsFor({
        agentHomeDir: sources.agentHomeDir,
        composedSkillsDir: null,
        globalArtifactsDir: sources.globalArtifactsDir,
        runDir: sources.runDir,
        workspaceDir: sources.workspaceDir,
      })
    );

    expect(dirs).toEqual([
      sources.globalArtifactsDir,
      join(sources.globalArtifactsDir, "manager"),
      sources.workspaceDir,
    ]);
  });

  test("counts nothing for a container that was given no tree", () => {
    expect(instructionDirsOf([])).toEqual([]);
  });
});

describe("the measurement", () => {
  test("adds up only the files that are there, root first", async () => {
    const sources = sourcesOf();
    writeInstructions(sources.globalArtifactsDir, 100);
    writeInstructions(sources.workspaceDir, 20);

    const budget = await measure(mountsFor(sources, NO_MOUNT_EXTRAS));

    expect(budget.files.map((file) => file.bytes)).toEqual([100, 20]);
    expect(budget.totalBytes).toBe(120);
    expect(budget.overBudget).toBe(false);
  });

  test("says a tree is over budget once the levels together pass the cap", async () => {
    const sources = sourcesOf();
    // A shade over half each: neither document is close to the cap on its own,
    // which is the case a per-file check would miss.
    const half = Math.ceil(INSTRUCTION_BUDGET_WARN_BYTES / 2) + 1;
    writeInstructions(sources.globalArtifactsDir, half);
    writeInstructions(sources.projectArtifactsDir as string, half);

    const budget = await measure(mountsFor(sources));

    expect(budget.totalBytes).toBe(half * 2);
    expect(budget.overBudget).toBe(true);
  });

  /**
   * The cap is Codex's own default, and it is the number to warn at whatever
   * this install has raised the setting to: a raised cap moves the cliff, it
   * does not remove it.
   */
  test("stays quiet at exactly the cap, because the cliff is past it", async () => {
    const sources = sourcesOf();
    writeInstructions(
      sources.globalArtifactsDir,
      INSTRUCTION_BUDGET_WARN_BYTES
    );

    const budget = await measure(mountsFor(sources));

    expect(budget.totalBytes).toBe(INSTRUCTION_BUDGET_WARN_BYTES);
    expect(budget.overBudget).toBe(false);
  });
});
