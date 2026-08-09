/**
 * The chain check, driven over hand-built chains and over the real one.
 *
 * The last test is the one that earns its keep: it reads `packages/db/drizzle`
 * as it stands in the working tree, so a merge that forks the chain fails
 * `bun test` without anyone remembering to run the script. The rest pin the
 * shapes down one at a time, and the fork case is the one that actually
 * happened — two pull requests both generated on `20260807084941_system_notices`,
 * different folder names, no git conflict.
 */

import { describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  describeProblem,
  findProblems,
  headOf,
  MIGRATIONS_DIR,
  type Migration,
  readMigrations,
  readMissingSql,
} from "./migrations-check";

const EMPTY = "00000000-0000-0000-0000-000000000000";
const ID_A = "aaaa1111-0000-0000-0000-000000000000";
const ID_B = "bbbb2222-0000-0000-0000-000000000000";
const ID_C = "cccc3333-0000-0000-0000-000000000000";
const ID_D = "dddd4444-0000-0000-0000-000000000000";

const at = (name: string, id: string, ...prevIds: string[]): Migration => ({
  id,
  kind: "snapshot",
  name,
  prevIds,
});

/** Three migrations in one line: the shape everything else is measured against. */
const INIT = at("20260801_init", ID_A, EMPTY);
const SECOND = at("20260802_second", ID_B, ID_A);
const THIRD = at("20260803_third", ID_C, ID_B);
const LINEAR = [INIT, SECOND, THIRD];

const kinds = (migrations: readonly Migration[]) =>
  findProblems(migrations).map((problem) => problem.kind);

const sentences = (migrations: readonly Migration[]) =>
  findProblems(migrations).map(describeProblem).join("\n");

describe("findProblems", () => {
  test("says nothing about a chain that is one line", () => {
    expect(findProblems(LINEAR)).toEqual([]);
    expect(headOf(LINEAR)?.name).toBe("20260803_third");
  });

  test("finds the fork two branches leave behind after a merge", () => {
    // The ids are verbatim from main, PR #41 and PR #43: both new migrations
    // name the system_notices snapshot as their parent, so git merged both
    // folders and the next generate would diff against one of them.
    const apiKeys = "0daa6a6e-85d8-4307-8b57-f4fd564f99b6";
    const notices = "d3dc262e-14d4-4bd8-9163-6710c8716781";
    const merged = [
      at("20260806192247_api_keys", apiKeys, EMPTY),
      at("20260807084941_system_notices", notices, apiKeys),
      at(
        "20260808150704_proposals",
        "e23107a9-eca0-4d44-9ece-2c4bae178077",
        notices
      ),
      at(
        "20260808165848_session_usage",
        "fa06e021-161d-4e9c-9925-a1d03b6709c8",
        notices
      ),
    ];

    expect(findProblems(merged)).toEqual([
      {
        kind: "fork",
        names: ["20260808150704_proposals", "20260808165848_session_usage"],
        parent: "20260807084941_system_notices",
      },
    ]);
    expect(sentences(merged)).toContain("git merged both");
  });

  test("finds two snapshots generated with the same id", () => {
    // PR #43's own pair: one id, one parent, two folders.
    const same = "e23107a9-eca0-4d44-9ece-2c4bae178077";
    expect(
      kinds([
        INIT,
        at("20260808150704_proposals", same, ID_A),
        at("20260808150800_trigger", same, ID_A),
      ])
    ).toEqual(["duplicate-id", "fork"]);
  });

  test("finds a parent no folder here holds", () => {
    expect(findProblems([INIT, at("20260802_second", ID_B, "gone")])).toEqual([
      { kind: "unknown-parent", name: "20260802_second", parent: "gone" },
    ]);
  });

  test("finds a chain with no start, and one with two", () => {
    expect(kinds([SECOND, THIRD])).toEqual(["unknown-parent", "roots"]);
    expect(kinds([INIT, at("20260802_other", ID_D, EMPTY)])).toEqual(["roots"]);
  });

  test("finds a migration that names more than one parent", () => {
    expect(
      findProblems([INIT, at("20260802_second", ID_B, ID_A, EMPTY)])
    ).toEqual([
      { kind: "parents", name: "20260802_second", parents: [ID_A, EMPTY] },
    ]);
  });

  test("finds a loop that hangs off the side of the chain", () => {
    expect(
      findProblems([
        INIT,
        at("20260802_a", ID_B, ID_C),
        at("20260803_b", ID_C, ID_B),
      ])
    ).toEqual([{ kind: "detached", names: ["20260802_a", "20260803_b"] }]);
  });

  test("finds a folder name that sorts before the one it follows", () => {
    expect(
      findProblems([
        at("20260803_init", ID_A, EMPTY),
        at("20260801_later", ID_B, ID_A),
      ])
    ).toEqual([
      { kind: "out-of-order", name: "20260801_later", parent: "20260803_init" },
    ]);
  });

  test("passes a folder it could not read straight through", () => {
    const unreadable = {
      kind: "unreadable",
      name: "20260804_half",
      reason: "no `id`",
    } as const;
    expect(findProblems([...LINEAR, unreadable])).toEqual([unreadable]);
  });
});

describe("readMigrations", () => {
  /** A throwaway migrations folder holding real files, as drizzle would write them. */
  const write = async (
    folders: readonly {
      readonly name: string;
      readonly snapshot?: string;
      readonly sql?: boolean;
    }[]
  ) => {
    const dir = await mkdtemp(join(tmpdir(), "migrations-check-"));
    await Promise.all(
      folders.map(async ({ name, snapshot, sql = true }) => {
        await mkdir(join(dir, name));
        await Promise.all([
          snapshot === undefined
            ? undefined
            : writeFile(join(dir, name, "snapshot.json"), snapshot),
          sql
            ? writeFile(join(dir, name, "migration.sql"), "SELECT 1;")
            : undefined,
        ]);
      })
    );
    return dir;
  };

  test("reads real folders in the order drizzle applies them", async () => {
    const dir = await write([
      { name: "20260802_second", snapshot: `{"id":"b","prevIds":["a"]}` },
      { name: "20260801_init", snapshot: `{"id":"a","prevIds":["${EMPTY}"]}` },
    ]);
    try {
      const migrations = await readMigrations(dir);
      expect(migrations.map(({ name }) => name)).toEqual([
        "20260801_init",
        "20260802_second",
      ]);
      expect(findProblems(migrations)).toEqual([]);
      expect(await readMissingSql(dir, migrations)).toEqual([]);
    } finally {
      await rm(dir, { recursive: true });
    }
  });

  test("reports a folder whose snapshot is absent, broken or the wrong shape", async () => {
    const dir = await write([
      { name: "20260801_absent" },
      { name: "20260802_broken", snapshot: "{ not json" },
      { name: "20260803_shape", snapshot: `{"prevIds":["a"]}` },
      {
        name: "20260804_nosql",
        snapshot: `{"id":"d","prevIds":["${EMPTY}"]}`,
        sql: false,
      },
    ]);
    try {
      const migrations = await readMigrations(dir);
      expect(
        migrations
          .filter(({ kind }) => kind === "unreadable")
          .map(({ name }) => name)
      ).toEqual(["20260801_absent", "20260802_broken", "20260803_shape"]);
      expect(await readMissingSql(dir, migrations)).toEqual([
        { kind: "missing-sql", name: "20260804_nosql" },
      ]);
    } finally {
      await rm(dir, { recursive: true });
    }
  });
});

test("the migrations checked into this repository are one chain", async () => {
  const migrations = await readMigrations(MIGRATIONS_DIR);
  expect(migrations.length).toBeGreaterThan(0);
  expect(findProblems(migrations).map(describeProblem)).toEqual([]);
  expect(await readMissingSql(MIGRATIONS_DIR, migrations)).toEqual([]);
  expect(headOf(migrations)).toBeDefined();
});
