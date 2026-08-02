import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BunFileSystem } from "@effect/platform-bun";
import {
  newProjectId,
  newRunId,
  newTaskId,
  WorkspaceId,
} from "@workspace/domain";
import { runDirOf } from "@workspace/harness";
import { Effect, Exit } from "effect";
import {
  globalArtifactsDirOf,
  projectArtifactsDirOf,
  taskArtifactsDirOf,
} from "./artifacts";
import { CloneFailed } from "./errors";
import { eventLogDirOf } from "./mounts";
import type { MaterializeInput, RepoSource } from "./spec";
import { Workspace } from "./spec";
import {
  type CloneIntoWorkspace,
  localWorkspaceLayer,
  workspaceDirOf,
} from "./workspace";

let root: string;
let dataRoot: string;
let originDir: string;

const identity = {
  runId: newRunId(),
  sessionId: null,
  taskId: newTaskId(),
  traceparent: null,
  workspaceId: WorkspaceId.make("ws-test"),
};

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "workspace-"));
  dataRoot = join(root, "data");
  originDir = join(root, "origin");
  mkdirSync(originDir, { recursive: true });
});

afterEach(() => {
  rmSync(root, { force: true, recursive: true });
});

/** A real repository on disk, so "a repo workspace is not empty" is a real clone. */
const seedOrigin = () => {
  const git = (...args: readonly string[]) =>
    execFileSync("git", [...args], { cwd: originDir, stdio: "pipe" });
  git("init", "-q", "-b", "main");
  git("config", "user.email", "test@example.com");
  git("config", "user.name", "Test");
  writeFileSync(join(originDir, "README.md"), "# origin\n");
  git("add", "README.md");
  git("commit", "-q", "-m", "first");
};

const repoSource: RepoSource = {
  baseRef: "origin/main",
  branch: "atm/test",
  cloneUrl: null,
  get mirrorDir() {
    return originDir;
  },
};

/** Stands in for `./repo`: a real `git clone`, with git's own stderr on failure. */
const gitClone: CloneIntoWorkspace = (input) =>
  Effect.try({
    catch: (cause) =>
      new CloneFailed({
        exitCode: null,
        repo: input.repo.mirrorDir,
        stderr: String(
          (cause as { readonly stderr?: unknown }).stderr ?? cause
        ),
      }),
    try: () => {
      execFileSync(
        "git",
        ["clone", "-q", input.repo.mirrorDir, input.targetDir],
        {
          stdio: "pipe",
        }
      );
    },
  });

const refusingClone: CloneIntoWorkspace = (input) =>
  Effect.fail(
    new CloneFailed({
      exitCode: 128,
      repo: input.repo.mirrorDir,
      stderr: "fatal: repository does not exist",
    })
  );

const materializeInput = (repo: RepoSource | null, projectId = null) =>
  ({ dataRoot, identity, projectId, repo }) as MaterializeInput;

/** Runs one materialization and hands the result to the assertions, inside the scope. */
const withWorkspace = <A>(options: {
  readonly clone: CloneIntoWorkspace;
  readonly input: MaterializeInput;
  readonly use: (workspace: {
    readonly branch: string | null;
    readonly workspaceDir: string;
  }) => A;
}) =>
  Effect.runPromiseExit(
    Effect.scoped(
      Effect.gen(function* () {
        const workspace = yield* Workspace;
        const materialized = yield* workspace.materialize(options.input);
        return { materialized, used: options.use(materialized) };
      })
    ).pipe(
      Effect.provide(localWorkspaceLayer({ clone: options.clone })),
      Effect.provide(BunFileSystem.layer)
    )
  );

describe("materialize", () => {
  test("a task with no repo gets an empty scratch directory", async () => {
    const exit = await withWorkspace({
      clone: refusingClone,
      input: materializeInput(null),
      use: (workspace) => readdirSync(workspace.workspaceDir),
    });

    expect(Exit.isSuccess(exit)).toBe(true);
    if (!Exit.isSuccess(exit)) {
      return;
    }
    expect(exit.value.used).toEqual([]);
    expect(exit.value.materialized.branch).toBe(null);
    expect(exit.value.materialized.strategy).toBe("mount");
    expect(exit.value.materialized.workspaceDir).toBe(
      workspaceDirOf({ dataRoot, runId: identity.runId })
    );
  });

  test("a task with a repo gets a checkout, and the branch it will push", async () => {
    seedOrigin();
    const exit = await withWorkspace({
      clone: gitClone,
      input: materializeInput(repoSource),
      use: (workspace) => readdirSync(workspace.workspaceDir),
    });

    expect(Exit.isSuccess(exit)).toBe(true);
    if (!Exit.isSuccess(exit)) {
      return;
    }
    expect(exit.value.used.sort()).toEqual([".git", "README.md"]);
    expect(exit.value.materialized.branch).toBe("atm/test");
  });

  test("the run directory and its event ledger directory exist to be mounted", async () => {
    const exit = await withWorkspace({
      clone: refusingClone,
      input: materializeInput(null),
      use: () => null,
    });

    expect(Exit.isSuccess(exit)).toBe(true);
    const runDir = runDirOf({ dataRoot, runId: identity.runId });
    expect(existsSync(runDir)).toBe(true);
    expect(existsSync(eventLogDirOf(runDir))).toBe(true);
  });

  test("a task with no project gets no project folder to mount", async () => {
    const exit = await withWorkspace({
      clone: refusingClone,
      input: materializeInput(null),
      use: () => null,
    });

    expect(Exit.isSuccess(exit)).toBe(true);
    if (!Exit.isSuccess(exit)) {
      return;
    }
    expect(exit.value.materialized.projectArtifactsDir).toBe(null);
    expect(
      existsSync(taskArtifactsDirOf({ dataRoot, taskId: identity.taskId }))
    ).toBe(true);
    expect(existsSync(globalArtifactsDirOf(dataRoot))).toBe(true);
  });

  test("a task with a project gets its promoted folder", async () => {
    const projectId = newProjectId();
    const exit = await withWorkspace({
      clone: refusingClone,
      input: { ...materializeInput(null), projectId },
      use: () => null,
    });

    expect(Exit.isSuccess(exit)).toBe(true);
    if (!Exit.isSuccess(exit)) {
      return;
    }
    expect(exit.value.materialized.projectArtifactsDir).toBe(
      projectArtifactsDirOf({ dataRoot, projectId })
    );
    expect(existsSync(projectArtifactsDirOf({ dataRoot, projectId }))).toBe(
      true
    );
  });
});

describe("scope close", () => {
  test("takes the checkout back and leaves the run and artifact directories", async () => {
    seedOrigin();
    const exit = await withWorkspace({
      clone: gitClone,
      input: materializeInput(repoSource),
      use: (workspace) => existsSync(workspace.workspaceDir),
    });

    expect(Exit.isSuccess(exit)).toBe(true);
    if (!Exit.isSuccess(exit)) {
      return;
    }
    expect(exit.value.used).toBe(true);
    expect(existsSync(exit.value.materialized.workspaceDir)).toBe(false);
    expect(existsSync(exit.value.materialized.runDir)).toBe(true);
    expect(existsSync(exit.value.materialized.taskArtifactsDir)).toBe(true);
  });

  test("a clone that fails leaves no half-made checkout behind", async () => {
    const exit = await withWorkspace({
      clone: refusingClone,
      input: materializeInput(repoSource),
      use: () => null,
    });

    expect(Exit.isFailure(exit)).toBe(true);
    expect(
      existsSync(workspaceDirOf({ dataRoot, runId: identity.runId }))
    ).toBe(false);
  });
});
