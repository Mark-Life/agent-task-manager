import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BunFileSystem } from "@effect/platform-bun";
import {
  type EnvFilePath,
  newProjectId,
  newRunId,
  newTaskId,
  type ProjectId,
  WorkspaceId,
} from "@workspace/domain";
import { ATM_ROOT_MARKER, runDirOf } from "@workspace/harness";
import { Effect, Exit } from "effect";
import {
  globalArtifactsDirOf,
  projectArtifactsDirOf,
  taskArtifactsDirOf,
} from "./artifacts";
import { CloneFailed } from "./errors";
import { eventLogDirOf, type RunLabels, runTreeOf, slugOf } from "./mounts";
import type { MaterializeInput, RepoSource } from "./spec";
import { Workspace } from "./spec";
import {
  type CloneIntoWorkspace,
  localWorkspaceLayer,
  workspaceDirOf,
} from "./workspace";

let root: string;
let agentHomeDir: string;
let dataRoot: string;
let originDir: string;

const taskId = newTaskId();

const identity = {
  runId: newRunId(),
  sessionId: null,
  taskId,
  traceparent: null,
  workspaceId: WorkspaceId.make("ws-test"),
};

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "workspace-"));
  agentHomeDir = join(root, "agent-home");
  dataRoot = join(root, "data");
  originDir = join(root, "origin");
  // The provider's login is the one mount source materialization never makes,
  // so the fixture is the operator who logged in by hand.
  mkdirSync(agentHomeDir, { mode: 0o700, recursive: true });
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

/** The names this file's runs spell their container paths with. */
const labels: RunLabels = {
  project: "Atlas Rewrite",
  repo: "mark-life/atlas",
  task: "Ship the CSV export",
};

const materializeInput = (
  repo: RepoSource | null,
  projectId: ProjectId | null = null,
  envFiles: MaterializeInput["envFiles"] = []
) =>
  ({
    agentHomeDir,
    dataRoot,
    envFiles,
    identity,
    labels: { ...labels, project: projectId === null ? null : labels.project },
    projectId,
    provider: "claude",
    repo,
    taskId,
  }) as MaterializeInput;

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
  test("refuses a run whose provider home does not exist, and does not create it", async () => {
    const absent = join(root, "never-logged-in");
    const exit = await withWorkspace({
      clone: refusingClone,
      input: { ...materializeInput(null), agentHomeDir: absent },
      use: () => null,
    });

    // An auto-created empty home is a container that boots and reports an auth
    // error nobody can tell from an expired token, so absence is a refusal.
    expect(Exit.isFailure(exit)).toBe(true);
    expect(existsSync(absent)).toBe(false);
  });

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

  /**
   * The marker is what a Codex run's upward walk stops at, and the harness
   * points `project_root_markers` at that name on every Codex turn. Without the
   * file the walk finds no root at all and the run reads the one `AGENTS.md` in
   * its checkout — quieter than the default it replaced, since nothing fails.
   */
  test("the top of the tree carries the marker a Codex run stops at", async () => {
    const exit = await withWorkspace({
      clone: refusingClone,
      input: materializeInput(null),
      use: () => null,
    });

    expect(Exit.isSuccess(exit)).toBe(true);
    expect(
      existsSync(join(globalArtifactsDirOf(dataRoot), ATM_ROOT_MARKER))
    ).toBe(true);
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
    expect(existsSync(taskArtifactsDirOf({ dataRoot, taskId }))).toBe(true);
    expect(existsSync(globalArtifactsDirOf(dataRoot))).toBe(true);
  });

  test("a task with a project gets its promoted folder", async () => {
    const projectId = newProjectId();
    const exit = await withWorkspace({
      clone: refusingClone,
      input: materializeInput(null, projectId),
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

/**
 * The scopes are bound at nested container paths, and the workspace scope is
 * read-only to a worker — so the daemon cannot create a destination through it
 * and the container refuses to start without one. These are the directories that
 * make the read-only parent workable, and nothing else on the host makes them.
 */
describe("the nested mount points", () => {
  test("exist inside the parent scope's own host directory", async () => {
    const projectId = newProjectId();
    const exit = await withWorkspace({
      clone: refusingClone,
      input: materializeInput(null, projectId),
      use: () => null,
    });

    expect(Exit.isSuccess(exit)).toBe(true);
    expect(
      existsSync(
        join(
          globalArtifactsDirOf(dataRoot),
          "worker",
          slugOf(String(labels.project))
        )
      )
    ).toBe(true);
    expect(
      existsSync(
        join(
          projectArtifactsDirOf({ dataRoot, projectId }),
          slugOf(labels.task)
        )
      )
    ).toBe(true);
    expect(
      existsSync(
        join(
          taskArtifactsDirOf({ dataRoot, taskId }),
          slugOf(String(labels.repo))
        )
      )
    ).toBe(true);
  });

  test("follow the tree, so a task with no project has one level fewer", async () => {
    const exit = await withWorkspace({
      clone: refusingClone,
      input: materializeInput(null),
      use: () => null,
    });

    expect(Exit.isSuccess(exit)).toBe(true);
    const workerDir = join(globalArtifactsDirOf(dataRoot), "worker");
    // The task's own directory hangs straight off `worker/`, which is what
    // `runTreeOf` says for a task that belongs to no project.
    expect(readdirSync(workerDir)).toEqual([slugOf(labels.task)]);
    expect(runTreeOf({ ...labels, project: null }).taskScope).toBe(
      `/workspace/worker/${slugOf(labels.task)}`
    );
  });

  test("hold nothing, so the artifact scan finds nothing to record", async () => {
    const exit = await withWorkspace({
      clone: refusingClone,
      input: materializeInput(null),
      use: () => null,
    });

    expect(Exit.isSuccess(exit)).toBe(true);
    // A directory, and empty: `scanArtifacts` drops directories, so these are
    // invisible to every row and URL the rest of the system builds.
    const cloneMountPoint = join(
      taskArtifactsDirOf({ dataRoot, taskId }),
      slugOf(String(labels.repo))
    );
    expect(statSync(cloneMountPoint).isDirectory()).toBe(true);
    expect(readdirSync(cloneMountPoint)).toEqual([]);
  });
});

/** The permission bits as `chmod` prints them, without reaching for a mask. */
const modeOf = (path: string) => statSync(path).mode.toString(8).slice(-3);

describe("the project's env files", () => {
  // Cast rather than constructed through the schema, because two of the cases
  // below are paths the schema refuses — and the point of those is that the
  // materializer refuses them too, rather than trusting the brand it was handed.
  const envFile = (path: string, content: string) => [
    { content, path: path as EnvFilePath },
  ];

  test("land in the checkout, owner-readable and nothing more", async () => {
    const exit = await withWorkspace({
      clone: refusingClone,
      input: materializeInput(null, null, envFile(".env", "DATABASE_URL=x\n")),
      use: (workspace) => {
        const path = join(workspace.workspaceDir, ".env");
        return {
          mode: modeOf(path),
          text: readFileSync(path, "utf8"),
        };
      },
    });

    expect(Exit.isSuccess(exit)).toBe(true);
    if (!Exit.isSuccess(exit)) {
      return;
    }
    expect(exit.value.used.text).toBe("DATABASE_URL=x\n");
    expect(exit.value.used.mode).toBe("600");
    expect(exit.value.materialized.envFiles.paths).toEqual([".env"]);
  });

  test("get their parent directories made for them", async () => {
    const exit = await withWorkspace({
      clone: refusingClone,
      input: materializeInput(
        null,
        null,
        envFile("apps/web/.env.local", "PORT=3000\n")
      ),
      use: (workspace) =>
        readFileSync(
          join(workspace.workspaceDir, "apps/web/.env.local"),
          "utf8"
        ),
    });

    expect(Exit.isSuccess(exit)).toBe(true);
    if (!Exit.isSuccess(exit)) {
      return;
    }
    expect(exit.value.used).toBe("PORT=3000\n");
  });

  // The checkout is a sibling of every other run's under one service account's
  // data root, and it now holds credentials.
  test("are written into a checkout no other account can enter", async () => {
    const exit = await withWorkspace({
      clone: refusingClone,
      input: materializeInput(null, null, envFile(".env", "A=1\n")),
      use: (workspace) => modeOf(workspace.workspaceDir),
    });

    expect(Exit.isSuccess(exit)).toBe(true);
    if (Exit.isSuccess(exit)) {
      expect(exit.value.used).toBe("700");
    }
  });

  test("are excluded from the checkout's git, so `git add .` cannot stage one", async () => {
    seedOrigin();
    const exit = await withWorkspace({
      clone: gitClone,
      input: materializeInput(
        repoSource,
        null,
        envFile(".env", "SECRET=shh\n")
      ),
      use: (workspace) => {
        const exclude = readFileSync(
          join(workspace.workspaceDir, ".git/info/exclude"),
          "utf8"
        );
        // git's own answer, not ours: whether the file would be added.
        const added = execFileSync("git", ["add", "--dry-run", "--all", "."], {
          cwd: workspace.workspaceDir,
          stdio: "pipe",
        }).toString();
        return { added, exclude };
      },
    });

    expect(Exit.isSuccess(exit)).toBe(true);
    if (!Exit.isSuccess(exit)) {
      return;
    }
    expect(exit.value.used.exclude).toContain(".env");
    expect(exit.value.used.added).not.toContain(".env");
    expect(exit.value.materialized.envFiles.excluded).toBe(true);
  });

  test("a checkout with no repo has nothing to exclude from, and that is not a failure", async () => {
    const exit = await withWorkspace({
      clone: refusingClone,
      input: materializeInput(null, null, envFile(".env", "A=1\n")),
      use: () => null,
    });

    expect(Exit.isSuccess(exit)).toBe(true);
    if (Exit.isSuccess(exit)) {
      expect(exit.value.materialized.envFiles.excluded).toBe(false);
    }
  });

  test("a path that escapes the checkout fails the run rather than writing", async () => {
    const outside = join(root, "escaped");
    const exit = await withWorkspace({
      clone: refusingClone,
      input: materializeInput(null, null, envFile("../escaped", "A=1\n")),
      use: () => null,
    });

    expect(Exit.isFailure(exit)).toBe(true);
    expect(existsSync(outside)).toBe(false);
  });

  // A repository can ship a directory as a symlink, and every segment of the
  // path is still an ordinary name — which is the one case the pure rule cannot
  // see.
  test("a parent that resolves through a symlink out of the checkout is refused", async () => {
    const target = join(root, "escape-target");
    mkdirSync(target, { recursive: true });
    const exit = await withWorkspace({
      clone: (input) =>
        Effect.sync(() => {
          symlinkSync(target, join(input.targetDir, "apps"));
        }),
      input: materializeInput(repoSource, null, envFile("apps/.env", "A=1\n")),
      use: () => null,
    });

    expect(Exit.isFailure(exit)).toBe(true);
    expect(existsSync(join(target, ".env"))).toBe(false);
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
