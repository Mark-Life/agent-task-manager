import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BunFileSystem } from "@effect/platform-bun";
import { newProjectId, newTaskId } from "@workspace/domain";
import { ATM_ROOT_MARKER } from "@workspace/harness";
import { DateTime, Effect } from "effect";
import type { FileSystem } from "effect/FileSystem";
import {
  artifactDirOf,
  artifactsRootOf,
  copyArtifact,
  ensureArtifactDir,
  extOf,
  globalArtifactsDirOf,
  projectArtifactsDirOf,
  promoteArtifact,
  scanArtifacts,
  taskArtifactsDirOf,
} from "./artifacts";

let dataRoot: string;
const taskId = newTaskId();
const projectId = newProjectId();

beforeEach(() => {
  dataRoot = mkdtempSync(join(tmpdir(), "artifacts-"));
});

afterEach(() => {
  rmSync(dataRoot, { force: true, recursive: true });
});

const run = <A, E>(program: Effect.Effect<A, E, FileSystem>) =>
  Effect.runPromise(program.pipe(Effect.provide(BunFileSystem.layer)));

const writeAt = (path: string, body: string) => {
  mkdirSync(join(path, ".."), { recursive: true });
  writeFileSync(path, body);
};

describe("path algebra", () => {
  test("all three scopes hang off one root, so search is one mount", () => {
    const root = artifactsRootOf(dataRoot);
    for (const dir of [
      globalArtifactsDirOf(dataRoot),
      projectArtifactsDirOf({ dataRoot, projectId }),
      taskArtifactsDirOf({ dataRoot, taskId }),
    ]) {
      expect(dir.startsWith(`${root}/`)).toBe(true);
    }
  });

  test("the three scopes resolve to three different directories", () => {
    const dirs = [
      artifactDirOf({ dataRoot, location: { scope: "global" } }),
      artifactDirOf({ dataRoot, location: { projectId, scope: "project" } }),
      artifactDirOf({ dataRoot, location: { scope: "task", taskId } }),
    ];
    expect(new Set(dirs).size).toBe(3);
    expect(dirs[1]).toContain(projectId);
    expect(dirs[2]).toContain(taskId);
  });

  test("extension is lowercase, dotless, and absent for a dotfile", () => {
    expect(extOf("report.MD")).toBe("md");
    expect(extOf("nested/data.csv")).toBe("csv");
    expect(extOf("Makefile")).toBe(null);
    expect(extOf(".gitignore")).toBe(null);
  });
});

/**
 * The global folder is also the top of every run's instruction tree, and Codex
 * reads the working directory alone when it walks up and finds no marker. So a
 * folder made without one is a Codex turn handed less than the default `.git`
 * marker used to give it — quietly, since nothing fails.
 */
describe("ensureArtifactDir", () => {
  test("creates on demand and is safe to repeat", async () => {
    const location = { scope: "task", taskId } as const;
    const first = await run(ensureArtifactDir({ dataRoot, location }));
    const second = await run(ensureArtifactDir({ dataRoot, location }));
    expect(first).toBe(taskArtifactsDirOf({ dataRoot, taskId }));
    expect(second).toBe(first);
  });

  test("says the global folder is the top of the tree, with the marker Codex stops at", async () => {
    const dir = await run(
      ensureArtifactDir({ dataRoot, location: { scope: "global" } })
    );
    expect(readFileSync(join(dir, ATM_ROOT_MARKER), "utf-8")).toBe("");
  });

  test("leaves the marker alone on a folder that already has one", async () => {
    const location = { scope: "global" } as const;
    const dir = await run(ensureArtifactDir({ dataRoot, location }));
    // What an operator can put in it is theirs. Nothing reads the contents —
    // only the name decides where the walk stops — so a second run must not
    // write over it.
    writeFileSync(join(dir, ATM_ROOT_MARKER), "edited by hand");
    await run(ensureArtifactDir({ dataRoot, location }));
    expect(readFileSync(join(dir, ATM_ROOT_MARKER), "utf-8")).toBe(
      "edited by hand"
    );
  });

  test("marks no scope below the top of the tree", async () => {
    const dir = await run(
      ensureArtifactDir({ dataRoot, location: { projectId, scope: "project" } })
    );
    expect(existsSync(join(dir, ATM_ROOT_MARKER))).toBe(false);
  });
});

describe("scanArtifacts", () => {
  test("a directory that was never created scans to nothing", async () => {
    const rows = await run(
      scanArtifacts(taskArtifactsDirOf({ dataRoot, taskId }))
    );
    expect(rows).toEqual([]);
  });

  test("reads path, size and extension for nested files, sorted", async () => {
    const dir = await run(
      ensureArtifactDir({ dataRoot, location: { scope: "task", taskId } })
    );
    writeAt(join(dir, "report.md"), "# hello");
    writeAt(join(dir, "nested/data.csv"), "a,b\n1,2\n");

    const rows = await run(scanArtifacts(dir));
    expect(rows.map((row) => row.path)).toEqual([
      "nested/data.csv",
      "report.md",
    ]);
    expect(rows.map((row) => row.ext)).toEqual(["csv", "md"]);
    expect(rows.map((row) => row.bytes)).toEqual([8, 7]);
  });

  test("directories are not rows and .git is not indexed", async () => {
    const dir = await run(
      ensureArtifactDir({ dataRoot, location: { scope: "task", taskId } })
    );
    writeAt(join(dir, "keep.txt"), "kept");
    writeAt(join(dir, ".git/objects/ab/cdef"), "loose object");

    const rows = await run(scanArtifacts(dir));
    expect(rows.map((row) => row.path)).toEqual(["keep.txt"]);
  });

  test("modified time comes from the file, not from the scan", async () => {
    const dir = await run(
      ensureArtifactDir({ dataRoot, location: { scope: "task", taskId } })
    );
    writeAt(join(dir, "report.md"), "# hello");
    const [row] = await run(scanArtifacts(dir));
    expect(row).toBeDefined();
    const age = Date.now() - DateTime.toEpochMillis(row?.modifiedAt as never);
    expect(age).toBeLessThan(60_000);
  });
});

describe("copyArtifact", () => {
  test("copies the bytes and hashes what it wrote", async () => {
    const from = await run(
      ensureArtifactDir({ dataRoot, location: { scope: "task", taskId } })
    );
    const to = await run(
      ensureArtifactDir({ dataRoot, location: { scope: "global" } })
    );
    writeAt(join(from, "notes/plan.md"), "budapest");

    const copy = await run(
      copyArtifact({
        from: { dir: from, path: "notes/plan.md" },
        to: { dir: to, path: "notes/plan.md" },
      })
    );

    expect(readFileSync(join(to, "notes/plan.md"), "utf8")).toBe("budapest");
    expect(copy.bytes).toBe(8);
    expect(copy.path).toBe("notes/plan.md");
    expect(copy.contentHash.startsWith("sha256:")).toBe(true);
  });

  test("the copy is bytes, so refining the source does not rewrite it", async () => {
    const from = await run(
      ensureArtifactDir({ dataRoot, location: { scope: "task", taskId } })
    );
    const to = await run(
      ensureArtifactDir({ dataRoot, location: { projectId, scope: "project" } })
    );
    writeAt(join(from, "plan.md"), "first draft");
    const copy = await run(
      copyArtifact({
        from: { dir: from, path: "plan.md" },
        to: { dir: to, path: "plan.md" },
      })
    );

    writeFileSync(join(from, "plan.md"), "a later, different draft");

    expect(readFileSync(join(to, "plan.md"), "utf8")).toBe("first draft");
    const rehashed = await run(
      copyArtifact({
        from: { dir: from, path: "plan.md" },
        to: { dir: to, path: "plan-2.md" },
      })
    );
    expect(rehashed.contentHash).not.toBe(copy.contentHash);
  });
});

describe("promoteArtifact", () => {
  test("task to project leaves the original where it was", async () => {
    const taskDir = await run(
      ensureArtifactDir({ dataRoot, location: { scope: "task", taskId } })
    );
    writeAt(join(taskDir, "research.md"), "findings");

    const promoted = await run(
      promoteArtifact({
        dataRoot,
        path: "research.md",
        taskId,
        to: { projectId, scope: "project" },
      })
    );

    expect(promoted.path).toBe("research.md");
    expect(
      readFileSync(
        join(projectArtifactsDirOf({ dataRoot, projectId }), "research.md"),
        "utf8"
      )
    ).toBe("findings");
    expect(readFileSync(join(taskDir, "research.md"), "utf8")).toBe("findings");
  });

  test("task to global creates the shared folder on the way", async () => {
    const taskDir = await run(
      ensureArtifactDir({ dataRoot, location: { scope: "task", taskId } })
    );
    writeAt(join(taskDir, "style-guide.md"), "house style");

    await run(
      promoteArtifact({
        dataRoot,
        path: "style-guide.md",
        taskId,
        to: { scope: "global" },
      })
    );

    expect(
      readFileSync(
        join(globalArtifactsDirOf(dataRoot), "style-guide.md"),
        "utf8"
      )
    ).toBe("house style");
  });
});
