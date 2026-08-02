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
import { dirname, join } from "node:path";
import { BunFileSystem } from "@effect/platform-bun";
import { newTaskId, type TaskId } from "@workspace/domain";
import { Effect, Layer } from "effect";
import type { FileSystem } from "effect/FileSystem";
import { CloneFailed } from "./errors";
import { Git } from "./git";
import {
  BRANCH_PREFIX,
  baseRefOf,
  branchForTask,
  DEFAULT_COMMITTER,
  ensureMirror,
  materializeRepo,
  mirrorDirOf,
  parseRepoUrl,
  refreshMirror,
  repoLabelOf,
  repoSourceFor,
} from "./repo";
import type { RepoSource } from "./spec";

describe("parseRepoUrl", () => {
  test("takes an https url apart", () => {
    expect(parseRepoUrl("https://github.com/Mark-Life/factory.git")).toEqual({
      cloneUrl: "https://github.com/Mark-Life/factory.git",
      host: "github.com",
      name: "factory",
      owner: "Mark-Life",
      slug: "Mark-Life/factory",
    });
  });

  test("takes the ssh shorthand apart", () => {
    expect(parseRepoUrl("git@github.com:Mark-Life/factory.git")?.slug).toBe(
      "Mark-Life/factory"
    );
    expect(parseRepoUrl("ssh://git@github.com/Mark-Life/factory")?.name).toBe(
      "factory"
    );
  });

  test("normalizes the host and the trailing slash", () => {
    const repo = parseRepoUrl("  https://GitHub.com/o/n/  ");
    expect(repo?.host).toBe("github.com");
    expect(repo?.cloneUrl).toBe("https://GitHub.com/o/n");
  });

  test("accepts a host that is not github", () => {
    expect(parseRepoUrl("https://gitlab.com/o/n.git")?.host).toBe("gitlab.com");
  });

  test("answers null for anything that is not a clone url", () => {
    for (const raw of [
      "",
      "   ",
      "the marketing site repo",
      "owner/name",
      "https://github.com/owner",
      "https://github.com/owner/name/tree/main/pkg",
      "/Users/me/code/project",
    ]) {
      expect(parseRepoUrl(raw)).toBeNull();
    }
  });
});

describe("paths and names", () => {
  test("a mirror path encodes the slug, and the label reads it back", () => {
    const repo = parseRepoUrl("https://github.com/Mark-Life/factory.git");
    if (repo === null) {
      throw new Error("fixture url must parse");
    }
    const dir = mirrorDirOf({ dataRoot: "/data", repo });
    expect(dir).toBe("/data/mirrors/github.com/Mark-Life/factory.git");
    expect(repoLabelOf(dir)).toBe("Mark-Life/factory");
  });

  test("the base ref is a remote-tracking ref, or HEAD when unnamed", () => {
    expect(baseRefOf("main")).toBe("origin/main");
    expect(baseRefOf("  develop ")).toBe("origin/develop");
    expect(baseRefOf(null)).toBe("HEAD");
    expect(baseRefOf("   ")).toBe("HEAD");
  });

  test("a task's branch is stable across attempts", () => {
    const taskId = newTaskId();
    expect(branchForTask(taskId)).toBe(`${BRANCH_PREFIX}/task-${taskId}`);
    expect(branchForTask(taskId)).toBe(branchForTask(taskId));
    expect(branchForTask(taskId)).not.toBe(branchForTask(newTaskId()));
  });
});

describe("repoSourceFor", () => {
  const taskId = newTaskId();

  test("ties the mirror, the branch and the base together", () => {
    expect(
      repoSourceFor({
        dataRoot: "/data",
        defaultBranch: "main",
        repoUrl: "https://github.com/o/n.git",
        taskId,
      })
    ).toEqual({
      baseRef: "origin/main",
      branch: `${BRANCH_PREFIX}/task-${taskId}`,
      cloneUrl: "https://github.com/o/n.git",
      mirrorDir: "/data/mirrors/github.com/o/n.git",
    });
  });

  test("is null for a task with no repo", () => {
    for (const repoUrl of [null, "", "a trip to Lisbon"]) {
      expect(
        repoSourceFor({
          dataRoot: "/data",
          defaultBranch: null,
          repoUrl,
          taskId,
        })
      ).toBeNull();
    }
  });
});

/**
 * The real half. Git is local and fast, so the mirror and the clone are
 * exercised against an actual repository rather than a scripted runner: the
 * things worth knowing here — that a local clone works, that `-B` off
 * `origin/main` lands on the right commit, that a refreshed mirror is visible
 * to the next run — are all facts about git, and a mock would assert only that
 * the argv is the argv this file writes.
 */
describe("materialization", () => {
  let root: string;
  let dataRoot: string;
  let origin: string;
  let taskId: TaskId;

  const layer = Layer.mergeAll(BunFileSystem.layer, Git.layer);

  const run = <A, E>(program: Effect.Effect<A, E, FileSystem | Git>) =>
    Effect.runPromise(Effect.provide(program, layer));

  /** Runs git in the fixture, with an identity so the commit does not need one. */
  const fixtureGit = (cwd: string, ...args: string[]) =>
    execFileSync(
      "git",
      [
        "-c",
        "user.email=fixture@atm.invalid",
        "-c",
        "user.name=fixture",
        ...args,
      ],
      { cwd, encoding: "utf8" }
    ).trim();

  const commit = (message: string, body: string) => {
    writeFileSync(join(origin, "README.md"), body);
    fixtureGit(origin, "add", "README.md");
    fixtureGit(origin, "commit", "-m", message);
    return fixtureGit(origin, "rev-parse", "HEAD");
  };

  const sourceFor = (): RepoSource => ({
    baseRef: "origin/main",
    branch: branchForTask(taskId),
    cloneUrl: origin,
    mirrorDir: join(dataRoot, "mirrors", "local", "fixture", "origin.git"),
  });

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "sandbox-repo-"));
    dataRoot = join(root, "data");
    origin = join(root, "origin");
    taskId = newTaskId();
    mkdirSync(origin, { recursive: true });
    fixtureGit(origin, "init", "-b", "main");
    commit("first", "one\n");
  });

  afterEach(() => {
    rmSync(root, { force: true, recursive: true });
  });

  test("creates the mirror once, then finds it", async () => {
    const source = sourceFor();
    const first = await run(ensureMirror(source));
    expect(first.created).toBe(true);
    expect(existsSync(join(source.mirrorDir, "HEAD"))).toBe(true);

    const second = await run(ensureMirror(source));
    expect(second.created).toBe(false);
    // The staging directory is moved into place, never left beside the mirror.
    expect(existsSync(`${source.mirrorDir}.staging`)).toBe(false);
  });

  test("two dispatches racing on a new repo both get a mirror", async () => {
    const source = sourceFor();
    const reports = await run(
      Effect.all([ensureMirror(source), ensureMirror(source)], {
        concurrency: "unbounded",
      })
    );
    // Exactly one side did the fetch; the loser's rename lost and it said so.
    expect(reports.filter((report) => report.created)).toHaveLength(1);
    expect(existsSync(join(source.mirrorDir, "HEAD"))).toBe(true);
    // Nothing is left behind: a staging directory is either renamed or removed.
    expect(
      readdirSync(dirname(source.mirrorDir)).filter((name) =>
        name.endsWith(".staging")
      )
    ).toEqual([]);
  });

  test("refuses to invent a mirror with no clone url", async () => {
    const failure = await Effect.runPromise(
      Effect.flip(
        Effect.provide(ensureMirror({ ...sourceFor(), cloneUrl: null }), layer)
      )
    );
    expect(failure).toBeInstanceOf(CloneFailed);
    expect(failure.repo).toBe("fixture/origin");
    expect(failure.exitCode).toBeNull();
  });

  test("clones from the mirror onto the task's branch", async () => {
    const head = fixtureGit(origin, "rev-parse", "HEAD");
    const source = sourceFor();
    const workspaceDir = join(root, "workspace");

    const checkout = await run(
      materializeRepo({ committer: null, repo: source, workspaceDir })
    );

    expect(checkout.branch).toBe(branchForTask(taskId));
    expect(checkout.headSha).toBe(head);
    expect(checkout.mirrorCreated).toBe(true);
    expect(checkout.strategy).toBe("mount");
    expect(fixtureGit(workspaceDir, "rev-parse", "--abbrev-ref", "HEAD")).toBe(
      checkout.branch
    );
    // The working tree is real, not a bare or empty checkout.
    expect(existsSync(join(workspaceDir, "README.md"))).toBe(true);
  });

  test("points origin at the remote and names the committer", async () => {
    const workspaceDir = join(root, "workspace");
    await run(
      materializeRepo({ committer: null, repo: sourceFor(), workspaceDir })
    );

    // Not the mirror on the host, which does not exist inside the container.
    expect(fixtureGit(workspaceDir, "remote", "get-url", "origin")).toBe(
      origin
    );
    // Read without the fixture's own `-c` overrides, so this is the repo's config.
    expect(
      execFileSync("git", ["config", "--local", "user.email"], {
        cwd: workspaceDir,
        encoding: "utf8",
      }).trim()
    ).toBe(DEFAULT_COMMITTER.email);
    // No upstream, so a plain `git push` creates the run's own head instead of
    // arguing with the base branch. `--get` exits non-zero when the key is unset.
    const upstream = (() => {
      try {
        return execFileSync(
          "git",
          ["config", "--get", `branch.${branchForTask(taskId)}.merge`],
          { cwd: workspaceDir, encoding: "utf8" }
        ).trim();
      } catch {
        return null;
      }
    })();
    expect(upstream).toBeNull();
  });

  test("a refreshed mirror is what the next run clones", async () => {
    const source = sourceFor();
    await run(
      materializeRepo({
        committer: null,
        repo: source,
        workspaceDir: join(root, "workspace-a"),
      })
    );

    const second = commit("second", "two\n");
    // Without the refresh the mirror still holds only the first commit.
    const stale = await run(
      materializeRepo({
        committer: null,
        repo: source,
        workspaceDir: join(root, "workspace-b"),
      })
    );
    expect(stale.headSha).not.toBe(second);

    await run(refreshMirror(source));
    const fresh = await run(
      materializeRepo({
        committer: null,
        repo: source,
        workspaceDir: join(root, "workspace-c"),
      })
    );
    expect(fresh.headSha).toBe(second);
    expect(fresh.mirrorCreated).toBe(false);
  });

  test("a missing mirror cannot be refreshed", async () => {
    const failure = await Effect.runPromise(
      Effect.flip(Effect.provide(refreshMirror(sourceFor()), layer))
    );
    expect(failure).toBeInstanceOf(CloneFailed);
    expect(failure.stderr).toContain("no mirror to refresh");
  });

  test("a bad base ref fails as a clone failure, not a bad checkout", async () => {
    const failure = await Effect.runPromise(
      Effect.flip(
        Effect.provide(
          materializeRepo({
            committer: null,
            repo: { ...sourceFor(), baseRef: "origin/nonexistent" },
            workspaceDir: join(root, "workspace"),
          }),
          layer
        )
      )
    );
    expect(failure).toBeInstanceOf(CloneFailed);
    expect(failure.exitCode).not.toBeNull();
    expect(failure.repo).toBe("fixture/origin");
  });
});
