/**
 * What this file defends: the old bytes of a shared folder survive the run that
 * replaced them, and no run ever fails because they did not.
 *
 * Real git against real temporary directories. A scripted runner would assert
 * that the right argv was composed, which is not the claim — the claim is that
 * `git log` afterwards answers "which run changed this file", and only git can
 * say whether it does.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BunFileSystem } from "@effect/platform-bun";
import type { ProjectId, RunId } from "@workspace/domain";
import { Effect, Layer, Logger } from "effect";
import {
  globalArtifactsDirOf,
  projectArtifactsDirOf,
  taskArtifactsDirOf,
} from "./artifacts";
import { Git } from "./git";
import { makeScopeHistory } from "./history";
import type { Committer } from "./repo";

const COMMITTER: Committer = {
  email: "1+tester@users.noreply.github.com",
  name: "The Tester",
};

const RUN_ONE = "019fe042-2d1b-773e-87f4-d0e44d815ed5" as RunId;
const RUN_TWO = "019fe042-2d1b-773e-87f4-d0e44d815ed6" as RunId;
const RUN_THREE = "019fe042-2d1b-773e-87f4-d0e44d815ed7" as RunId;
const PROJECT = "019fe042-2d1b-773e-87f4-d0e44d815ee0" as ProjectId;

let dataRoot: string;

beforeEach(() => {
  dataRoot = mkdtempSync(join(tmpdir(), "history-"));
});

afterEach(() => {
  rmSync(dataRoot, { force: true, recursive: true });
});

const layer = Layer.mergeAll(BunFileSystem.layer, Git.layer);

/**
 * Collects the one line a stepped-over failure leaves behind. The recorder is
 * total by design, so the report cannot tell "nothing had changed" from "git
 * refused" — the log is the only place the difference shows.
 */
const refusalLogger = (into: string[]) =>
  Logger.layer([
    Logger.make(({ message }) => {
      const first = Array.isArray(message) ? message[0] : message;
      if (typeof first === "string" && first.startsWith("scope history")) {
        into.push(first);
      }
    }),
  ]);

/** One snapshot of every shared scope this run touches. */
const record = (input: {
  readonly phase: "after" | "before";
  readonly projectId?: ProjectId;
  readonly runId?: RunId;
}) =>
  Effect.runPromise(
    Effect.gen(function* () {
      const history = yield* makeScopeHistory({ committer: COMMITTER });
      return yield* history.record({
        dataRoot,
        phase: input.phase,
        projectId: input.projectId ?? null,
        runId: input.runId ?? RUN_ONE,
      });
    }).pipe(Effect.provide(layer))
  );

/** Puts a file where a run's own writes would land. */
const write = (dir: string, name: string, body: string) => {
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, name), body);
};

const git = (dir: string, ...args: readonly string[]) =>
  execFileSync("git", args, { cwd: dir, encoding: "utf-8" }).trim();

const workspaceScope = () => globalArtifactsDirOf(dataRoot);
const projectScope = () =>
  projectArtifactsDirOf({ dataRoot, projectId: PROJECT });

describe("the first snapshot of a shared scope", () => {
  test("initialises a repository and commits what was already there", async () => {
    write(workspaceScope(), "AGENTS.md", "# House rules\n");

    const report = await record({ phase: "before" });

    expect(report.committed).toEqual(["workspace"]);
    expect(git(workspaceScope(), "log", "--format=%s")).toBe(
      `snapshot before run ${RUN_ONE}`
    );
  });

  /**
   * The message is how "which run changed this file" is asked of a folder, and
   * the author is how it is attributed. Both are the whole interface — there is
   * no metadata beside the repository saying either.
   */
  test("names the run in the message and the operator in the author", async () => {
    write(workspaceScope(), "notes.md", "first\n");
    await record({ phase: "before" });

    expect(git(workspaceScope(), "log", "--format=%an <%ae>")).toBe(
      `${COMMITTER.name} <${COMMITTER.email}>`
    );
    expect(
      git(workspaceScope(), "log", `--grep=${RUN_ONE}`, "--format=%s")
    ).toContain(RUN_ONE);
  });

  test("skips a scope whose folder nothing has created yet", async () => {
    const report = await record({ phase: "before", projectId: PROJECT });

    expect(report.committed).toEqual([]);
    expect(report.heads.project).toBeNull();
  });
});

/**
 * The provenance half: a run's row names the commit each shared folder stood at
 * when the run was handed it, so "which rules did that run have" is a `git show`
 * rather than a guess at what those folders hold today. A commit is what makes
 * that answer point at bytes somebody can still read.
 */
describe("the commit a scope stands at", () => {
  test("is reported for every shared scope the run touches", async () => {
    write(workspaceScope(), "AGENTS.md", "# House rules\n");
    write(projectScope(), "research.md", "an answer\n");

    const report = await record({ phase: "before", projectId: PROJECT });

    expect(report.heads.workspace).toBe(
      git(workspaceScope(), "rev-parse", "HEAD")
    );
    expect(report.heads.project).toBe(git(projectScope(), "rev-parse", "HEAD"));
    // Two repositories, so two histories: one commit cannot stand for both.
    expect(report.heads.workspace).not.toBe(report.heads.project);
  });

  /**
   * The common case by far. Most runs change nothing in the shared folders, and
   * a scope with no commit of its own still has rules the run was given.
   */
  test("is reported when the snapshot had nothing to commit", async () => {
    write(workspaceScope(), "AGENTS.md", "# House rules\n");
    const first = await record({ phase: "before" });

    const second = await record({ phase: "after" });

    expect(second.committed).toEqual([]);
    expect(second.heads.workspace).toBe(first.heads.workspace);
  });

  /** A run that never had a project was given no project rules to name. */
  test("is null for a scope this run does not have", async () => {
    write(workspaceScope(), "AGENTS.md", "# House rules\n");

    const report = await record({ phase: "before" });

    expect(report.heads.project).toBeNull();
    expect(report.heads.workspace).not.toBeNull();
  });
});

describe("a run that overwrote a file", () => {
  /** The whole point: the bytes the second run replaced are still readable. */
  test("leaves the replaced bytes in the history of the folder", async () => {
    write(projectScope(), "research.md", "the first answer\n");
    await record({ phase: "before", projectId: PROJECT, runId: RUN_ONE });

    write(projectScope(), "research.md", "the second answer\n");
    await record({ phase: "after", projectId: PROJECT, runId: RUN_TWO });

    const previous = git(projectScope(), "show", "HEAD~1:research.md");
    expect(previous).toBe("the first answer");
    expect(git(projectScope(), "log", "--format=%s")).toBe(
      [`snapshot after run ${RUN_TWO}`, `snapshot before run ${RUN_ONE}`].join(
        "\n"
      )
    );
  });

  test("records both shared scopes in one call and neither task folder", async () => {
    write(workspaceScope(), "AGENTS.md", "# House rules\n");
    write(projectScope(), "research.md", "an answer\n");
    write(
      taskArtifactsDirOf({ dataRoot, taskId: "t" as never }),
      "out.md",
      "x"
    );

    const report = await record({ phase: "before", projectId: PROJECT });

    expect(report.committed).toEqual(["workspace", "project"]);
    expect(() =>
      git(taskArtifactsDirOf({ dataRoot, taskId: "t" as never }), "log")
    ).toThrow();
  });
});

describe("a run that changed nothing", () => {
  /**
   * An empty commit per run per scope would bury the handful of commits that
   * carry a change, which is the same as having no history at all.
   */
  test("adds no commit, so the log stays readable", async () => {
    write(workspaceScope(), "AGENTS.md", "# House rules\n");
    await record({ phase: "before" });

    const report = await record({ phase: "after" });

    expect(report.committed).toEqual([]);
    expect(git(workspaceScope(), "rev-list", "--count", "HEAD")).toBe("1");
  });
});

describe("runs dispatched at the same instant", () => {
  /**
   * Every run shares the workspace folder, and git refuses a second `add` in a
   * repository that already has one running rather than waiting for it — exit
   * 128, "Unable to create index.lock". Unserialised this happens on every
   * simultaneous dispatch, so the snapshots have to take turns.
   *
   * The assertion is that nothing was refused, not that every call committed: a
   * run whose folder another run had just committed has nothing left to record,
   * and that is the right answer rather than a lost snapshot.
   */
  test("none of the snapshots is refused", async () => {
    mkdirSync(workspaceScope(), { recursive: true });
    writeFileSync(join(workspaceScope(), "AGENTS.md"), "# House rules\n");
    const refusals: string[] = [];

    const reports = await Effect.runPromise(
      Effect.gen(function* () {
        const history = yield* makeScopeHistory({ committer: COMMITTER });
        return yield* Effect.all(
          [RUN_ONE, RUN_TWO, RUN_THREE].map((runId) =>
            Effect.flatMap(
              Effect.sync(() =>
                writeFileSync(join(workspaceScope(), `${runId}.md`), runId)
              ),
              () =>
                history.record({
                  dataRoot,
                  phase: "before",
                  projectId: null,
                  runId,
                })
            )
          ),
          { concurrency: "unbounded" }
        );
      }).pipe(Effect.provide(layer), Effect.provide(refusalLogger(refusals)))
    );

    expect(refusals).toEqual([]);
    expect(reports.some((report) => report.committed.length > 0)).toBe(true);
    // Everything on disk reached the history, whichever call carried it.
    expect(git(workspaceScope(), "status", "--porcelain")).toBe("");
  });
});

describe("a scope that cannot be recorded", () => {
  /**
   * History is worth less than the run that produced the thing being historied,
   * so every failure here is logged and stepped over. A file where the
   * repository belongs is the cheapest way to make git refuse.
   */
  test("answers with no commit rather than failing", async () => {
    mkdirSync(workspaceScope(), { recursive: true });
    writeFileSync(join(workspaceScope(), ".git"), "not a repository");

    const report = await record({ phase: "before" });

    expect(report.committed).toEqual([]);
    // Nothing to point a run's row at either: a commit read off a snapshot that
    // was abandoned would name a tree nobody can vouch the run was handed.
    expect(report.heads.workspace).toBeNull();
  });
});
