/**
 * Where a manager turn stands, and what has to exist on the host before it can.
 *
 * A chat turn works under `manager/` rather than under any project, which is the
 * whole of why project rules never reach one — the CLI's upward walk from the
 * working directory crosses the manager's own scope and then the workspace scope
 * and stops. That is a claim about two paths agreeing: the directory the mount
 * set binds and the directory the prompt names. Both are asserted here, against
 * the real mount builder and a real temporary data root.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BunFileSystem } from "@effect/platform-bun";
import { newRunId } from "@workspace/domain";
import { globalArtifactsDirOf } from "@workspace/sandbox";
import { Effect, Exit } from "effect";
import {
  materializeThreadRun,
  type ThreadRunDirectories,
  threadPlacementOf,
} from "./chat-turn";

let root: string;
let agentHomeDir: string;
let dataRoot: string;

const runId = newRunId();

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "chat-turn-"));
  agentHomeDir = join(root, "agent-home");
  dataRoot = join(root, "data");
  mkdirSync(agentHomeDir, { recursive: true });
});

afterEach(() => {
  rmSync(root, { force: true, recursive: true });
});

/**
 * Materializes one turn's directories and reads something off them before the
 * scope closes. The scratch directory is released with that scope, so anything
 * asserted about it has to be asserted from inside.
 */
const withThreadRun = <A>(use: (dirs: ThreadRunDirectories) => A) =>
  Effect.runPromiseExit(
    Effect.scoped(
      Effect.map(
        materializeThreadRun({
          agentHomeDir,
          dataRoot,
          provider: "claude",
          runId,
        }),
        (dirs) => ({ dirs, used: use(dirs) })
      )
    ).pipe(Effect.provide(BunFileSystem.layer))
  );

describe("a manager turn's directories", () => {
  test("makes the scratch directory's mount point inside the workspace scope", async () => {
    const exit = await withThreadRun((dirs) =>
      existsSync(join(dirs.globalArtifactsDir, "manager", "scratch"))
    );

    expect(Exit.isSuccess(exit)).toBe(true);
    if (!Exit.isSuccess(exit)) {
      return;
    }
    // A bind needs its destination to exist inside the parent bind's host
    // directory. The daemon would make this one — the workspace scope is
    // writable for a manager — but it is made from the mount set instead, so a
    // turn that cannot start names the directory rather than failing as an
    // "invalid mount config".
    expect(exit.value.used).toBe(true);
    expect(exit.value.dirs.globalArtifactsDir).toBe(
      globalArtifactsDirOf(dataRoot)
    );
  });

  test("refuses a turn whose provider home does not exist, and does not create it", async () => {
    const absent = join(root, "never-logged-in");
    agentHomeDir = absent;
    const exit = await withThreadRun(() => null);

    expect(Exit.isFailure(exit)).toBe(true);
    expect(existsSync(absent)).toBe(false);
  });
});

describe("where a manager turn is told it stands", () => {
  const dirs: ThreadRunDirectories = {
    globalArtifactsDir: "/host/.data/artifacts/global",
    runDir: "/host/.data/runs/r1",
    workspaceDir: "/host/.data/workspaces/r1",
  };

  test("says the scratch directory is under the manager's own scope", () => {
    expect(threadPlacementOf({ dirs, kind: "docker" })).toEqual({
      artifactsDir: "/workspace/manager/scratch",
      branch: null,
      globalArtifactsDir: "/workspace",
      projectArtifactsDir: null,
      workspaceDir: "/workspace/manager/scratch",
    });
  });

  test("keeps the shared directory apart from the one that dies with the turn", () => {
    // They were the same path before the tree, and a manager that reads its one
    // writable directory as thrown away will not edit the house rules a worker
    // is handed — which is the point of giving it write access at all.
    const placed = threadPlacementOf({ dirs, kind: "docker" });
    expect(placed.globalArtifactsDir).not.toBe(placed.workspaceDir);
    expect(placed.artifactsDir).toBe(placed.workspaceDir);
  });

  test("names the host directories a local turn actually has", () => {
    expect(threadPlacementOf({ dirs, kind: "local" })).toEqual({
      artifactsDir: "/host/.data/workspaces/r1",
      branch: null,
      globalArtifactsDir: "/host/.data/artifacts/global",
      projectArtifactsDir: null,
      workspaceDir: "/host/.data/workspaces/r1",
    });
  });
});
