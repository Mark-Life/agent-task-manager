/**
 * The sweep, against a real data root on disk.
 *
 * A temporary directory rather than a stubbed filesystem, because every claim
 * here is about what a directory tree looks like: three levels of nesting under
 * `mirrors/`, a name that is not a uuid, a staging directory a killed clone left
 * beside a mirror. A fake would be this file asserting its own fixture.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BunFileSystem } from "@effect/platform-bun";
import { newRunId, type RunId } from "@workspace/domain";
import { runsRootOf } from "@workspace/harness";
import { Effect } from "effect";
import type { FileSystem } from "effect/FileSystem";
import { composedSkillsRootOf } from "./composed-skills";
import { mirrorDirOf } from "./repo";
import {
  checkoutsOf,
  compositionsOf,
  mirrorKeyOf,
  mirrorsOf,
  removeStrays,
  runDirectoriesOf,
  type StrayDirectory,
  strandedOf,
} from "./sweep";
import { workspacesRootOf } from "./workspace";

let dataRoot: string;

const RUN_A = newRunId();
const RUN_B = newRunId();

const run = <A>(effect: Effect.Effect<A, never, FileSystem>) =>
  Effect.runPromise(effect.pipe(Effect.provide(BunFileSystem.layer)));

const keysOf = (dirs: readonly StrayDirectory[]) =>
  dirs.map((dir) => dir.key).sort();

beforeEach(() => {
  dataRoot = mkdtempSync(join(tmpdir(), "sweep-"));
});

afterEach(() => {
  rmSync(dataRoot, { force: true, recursive: true });
});

describe("runDirectoriesOf", () => {
  test("is empty for a data root nothing has run under yet", async () => {
    expect(await run(runDirectoriesOf(dataRoot))).toEqual([]);
  });

  test("finds one directory per run, keyed by the run it is named after", async () => {
    for (const runId of [RUN_A, RUN_B]) {
      mkdirSync(join(runsRootOf(dataRoot), runId), { recursive: true });
    }
    const found = await run(runDirectoriesOf(dataRoot));
    expect(keysOf(found)).toEqual([RUN_A, RUN_B].sort());
    expect(found[0]?.path.startsWith(runsRootOf(dataRoot))).toBe(true);
  });

  test("leaves alone anything it cannot attribute to a run", async () => {
    const root = runsRootOf(dataRoot);
    mkdirSync(join(root, "not-a-run"), { recursive: true });
    mkdirSync(join(root, `${RUN_A}.tmp`), { recursive: true });
    writeFileSync(join(root, "README"), "");
    expect(await run(runDirectoriesOf(dataRoot))).toEqual([]);
  });
});

describe("checkoutsOf", () => {
  test("reads the checkouts tree, not the run tree", async () => {
    mkdirSync(join(runsRootOf(dataRoot), RUN_A), { recursive: true });
    mkdirSync(join(workspacesRootOf(dataRoot), RUN_B), { recursive: true });
    expect(keysOf(await run(checkoutsOf(dataRoot)))).toEqual([RUN_B]);
  });
});

describe("compositionsOf", () => {
  test("reads the compositions tree, which has a checkout's lifetime", async () => {
    mkdirSync(join(workspacesRootOf(dataRoot), RUN_A), { recursive: true });
    mkdirSync(join(composedSkillsRootOf(dataRoot), RUN_B), { recursive: true });
    expect(keysOf(await run(compositionsOf(dataRoot)))).toEqual([RUN_B]);
  });
});

describe("mirrorsOf", () => {
  const mirrorOf = (owner: string, name: string) =>
    mirrorDirOf({
      dataRoot,
      repo: {
        cloneUrl: `https://github.com/${owner}/${name}`,
        host: "github.com",
        name,
        owner,
        slug: `${owner}/${name}`,
      },
    });

  test("finds a bare mirror at the depth the path algebra puts it", async () => {
    const mirror = mirrorOf("mark-life", "agent-task-manager");
    mkdirSync(mirror, { recursive: true });
    expect(keysOf(await run(mirrorsOf(dataRoot)))).toEqual([mirror]);
  });

  test("keys a mirror by the path a repo url resolves to", () => {
    const mirror = mirrorOf("mark-life", "agent-task-manager");
    mkdirSync(mirror, { recursive: true });
    expect(
      mirrorKeyOf({
        dataRoot,
        repoUrl: "https://github.com/mark-life/agent-task-manager.git",
      })
    ).toBe(mirror);
  });

  test("a url that names no repository keys nothing", () => {
    expect(mirrorKeyOf({ dataRoot, repoUrl: "  " })).toBeNull();
  });

  test("skips the staging directory a killed clone leaves beside a mirror", async () => {
    const mirror = mirrorOf("mark-life", "agent-task-manager");
    mkdirSync(mirror, { recursive: true });
    // What `ensureMirror` clones into before the rename that publishes it. One
    // of these can belong to a clone another loop has in flight, which is why
    // the suffix and not the nesting is what makes a directory a mirror.
    mkdirSync(`${mirror}.7f3a.staging`, { recursive: true });
    expect(keysOf(await run(mirrorsOf(dataRoot)))).toEqual([mirror]);
  });

  test("does not descend past the repo level", async () => {
    const mirror = mirrorOf("mark-life", "agent-task-manager");
    mkdirSync(join(mirror, "objects", "pack"), { recursive: true });
    expect(keysOf(await run(mirrorsOf(dataRoot)))).toEqual([mirror]);
  });
});

describe("strandedOf", () => {
  const found: readonly StrayDirectory[] = [
    { key: RUN_A, path: join("runs", RUN_A) },
    { key: RUN_B, path: join("runs", RUN_B) },
  ];

  test("a directory nothing owns is stranded", () => {
    expect(keysOf(strandedOf({ found, keep: new Set() }))).toEqual(
      [RUN_A, RUN_B].sort()
    );
  });

  test("a directory something still owns is left alone", () => {
    expect(
      keysOf(strandedOf({ found, keep: new Set<string>([RUN_A]) }))
    ).toEqual([RUN_B]);
  });

  test("a keep set nobody could produce strands nothing", () => {
    // The failure mode that matters: a database that could not be read is not
    // a database that owns nothing, and treating it as one removes every live
    // run's checkout on the host.
    expect(strandedOf({ found, keep: null })).toEqual([]);
  });
});

describe("removeStrays", () => {
  test("removes a whole tree and answers with what is gone", async () => {
    const checkout = join(workspacesRootOf(dataRoot), RUN_A);
    mkdirSync(join(checkout, ".git"), { recursive: true });
    writeFileSync(join(checkout, ".env"), "SECRET=1");

    const removed = await run(
      removeStrays([{ key: RUN_A as RunId, path: checkout }])
    );
    expect(removed).toEqual([checkout]);
    expect(await run(checkoutsOf(dataRoot))).toEqual([]);
  });

  test("a directory that is already gone is not a failure", async () => {
    const missing = join(workspacesRootOf(dataRoot), RUN_B);
    expect(await run(removeStrays([{ key: RUN_B, path: missing }]))).toEqual([
      missing,
    ]);
  });

  test("removes nothing when the join stranded nothing", async () => {
    const checkout = join(workspacesRootOf(dataRoot), RUN_A);
    mkdirSync(checkout, { recursive: true });
    await run(
      removeStrays(
        strandedOf({
          found: await run(checkoutsOf(dataRoot)),
          keep: new Set<string>([RUN_A]),
        })
      )
    );
    expect(keysOf(await run(checkoutsOf(dataRoot)))).toEqual([RUN_A]);
  });
});
