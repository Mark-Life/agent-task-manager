#!/usr/bin/env bun

/**
 * Reads every migration snapshot and refuses a chain that has stopped being a
 * single line.
 *
 * The failure it exists for cannot be seen in a diff. Each snapshot names the
 * snapshot it was generated on top of, in `prevIds`, and drizzle-kit diffs the
 * schema against the last one in that line. Two branches that each add a
 * migration to the same head write two folders with different names and both
 * pointing at that head, so git merges them without a conflict and the chain
 * silently forks. Nothing complains. The next `db:generate` picks one side of
 * the fork as its base and emits a migration that undoes the other side's
 * columns, or re-creates them, depending on which side it landed on. There is
 * no `drizzle/meta` journal in this layout to catch it either.
 *
 * The check is pure file reads: it needs no database, no environment and no
 * network, so it runs in the same second as a lint. It runs before
 * `db:generate` for the same reason a merge is when the fork appears — the
 * moment someone generates on a forked chain is the moment the damage becomes
 * a committed SQL file.
 *
 *   bun run db:migrations-check     from the repository root
 *
 * Non-zero on anything wrong, with the folders named.
 * `migrations-check.test.ts` drives the same functions over hand-built chains,
 * and over the real folder, so a fork fails `bun test` as well.
 */

import { readdir, readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

/** The migration folder this repository keeps, relative to this script. */
export const MIGRATIONS_DIR = fileURLToPath(
  new URL("../drizzle", import.meta.url)
);

/** What drizzle writes as the parent of the very first migration. */
const NO_PARENT = "00000000-0000-0000-0000-000000000000";

/** Enough of a uuid to recognize it in a message, in the style drizzle prints. */
const ID_PREFIX_LENGTH = 8;

/** A migration folder that could be read: its two identifying fields. */
export interface Snapshot {
  readonly id: string;
  readonly kind: "snapshot";
  /** The folder name, which is also the order drizzle applies migrations in. */
  readonly name: string;
  readonly prevIds: readonly string[];
}

/** A migration folder that could not be read, and why. */
export interface Unreadable {
  readonly kind: "unreadable";
  readonly name: string;
  readonly reason: string;
}

export type Migration = Snapshot | Unreadable;

/**
 * One thing wrong with the chain. Each variant carries the folder names rather
 * than a rendered sentence, so a test can assert on what was found and
 * `describeProblem` can be the only place that decides how it reads.
 */
export type Problem =
  | Unreadable
  | { readonly kind: "missing-sql"; readonly name: string }
  | {
      readonly kind: "parents";
      readonly name: string;
      readonly parents: readonly string[];
    }
  | {
      readonly kind: "duplicate-id";
      readonly id: string;
      readonly names: readonly string[];
    }
  | {
      readonly kind: "unknown-parent";
      readonly name: string;
      readonly parent: string;
    }
  | {
      readonly kind: "fork";
      readonly parent: string;
      readonly names: readonly string[];
    }
  | { readonly kind: "roots"; readonly names: readonly string[] }
  | { readonly kind: "detached"; readonly names: readonly string[] }
  | {
      readonly kind: "out-of-order";
      readonly name: string;
      readonly parent: string;
    };

const shortId = (id: string) => id.slice(0, ID_PREFIX_LENGTH);

/** Folder names as a sentence reads them: "a", "a and b", "a, b and c". */
const list = (names: readonly string[]) =>
  names.length < 2
    ? (names[0] ?? "")
    : `${names.slice(0, -1).join(", ")} and ${names.at(-1)}`;

const groupBy = <T>(items: readonly T[], key: (item: T) => string) => {
  const groups = new Map<string, T[]>();
  for (const item of items) {
    const existing = groups.get(key(item));
    if (existing === undefined) {
      groups.set(key(item), [item]);
    } else {
      existing.push(item);
    }
  }
  return groups;
};

/** The two fields this check reads, taken off a parsed snapshot or refused. */
const asSnapshot = (name: string, parsed: unknown): Migration => {
  if (typeof parsed !== "object" || parsed === null) {
    return {
      kind: "unreadable",
      name,
      reason: "snapshot.json is not an object",
    };
  }
  const { id, prevIds } = parsed as { id?: unknown; prevIds?: unknown };
  if (typeof id !== "string") {
    return { kind: "unreadable", name, reason: "snapshot.json has no `id`" };
  }
  if (
    !(Array.isArray(prevIds) && prevIds.every((p) => typeof p === "string"))
  ) {
    return {
      kind: "unreadable",
      name,
      reason: "snapshot.json has no `prevIds` list of strings",
    };
  }
  return { id, kind: "snapshot", name, prevIds };
};

/**
 * Every migration folder, in the order drizzle applies them — folder name,
 * ascending. A folder that cannot be read becomes an `unreadable` entry rather
 * than an exception, because a half-written migration is one of the states this
 * is here to report.
 */
export const readMigrations = async (
  dir: string
): Promise<readonly Migration[]> => {
  const entries = await readdir(dir, { withFileTypes: true });
  const names = entries
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort();
  return await Promise.all(
    names.map(async (name): Promise<Migration> => {
      try {
        return asSnapshot(
          name,
          JSON.parse(await readFile(`${dir}/${name}/snapshot.json`, "utf8"))
        );
      } catch (cause) {
        return {
          kind: "unreadable",
          name,
          reason:
            cause instanceof Error
              ? `snapshot.json could not be read: ${cause.message}`
              : "snapshot.json could not be read",
        };
      }
    })
  );
};

/** Folders holding a snapshot but no SQL — the migration would apply nothing. */
export const readMissingSql = async (
  dir: string,
  migrations: readonly Migration[]
): Promise<readonly Problem[]> => {
  const missing = await Promise.all(
    migrations.map(async ({ name }) => {
      const files = await readdir(`${dir}/${name}`);
      return files.includes("migration.sql") ? null : name;
    })
  );
  return missing
    .filter((name) => name !== null)
    .map((name) => ({ kind: "missing-sql", name }));
};

/** The folders a problem already accounts for. */
const namesIn = (problem: Problem): readonly string[] =>
  "names" in problem ? problem.names : [problem.name];

/**
 * The snapshots reachable from the start, in chain order. It stops at a fork
 * and at a repeat rather than choosing a branch or looping: both are already
 * reported, and whatever lies beyond them lands in `detached`.
 */
const walk = (
  roots: readonly Snapshot[],
  children: ReadonlyMap<string, readonly Snapshot[]>
): readonly Snapshot[] => {
  const chain: Snapshot[] = [];
  let cursor = roots.length === 1 ? roots[0] : undefined;
  while (cursor !== undefined && !chain.includes(cursor)) {
    chain.push(cursor);
    const next = children.get(cursor.id);
    cursor = next?.length === 1 ? next[0] : undefined;
  }
  return chain;
};

/** The names of every group holding more than one snapshot. */
const shared = (grouped: ReadonlyMap<string, readonly Snapshot[]>) =>
  [...grouped]
    .filter(([, sharing]) => sharing.length > 1)
    .map(([key, sharing]) => [key, sharing.map(({ name }) => name)] as const);

/**
 * Each snapshot sorted by the parent it names: the ones that start a chain, the
 * ones that follow a snapshot present here, and the ones whose `prevIds` is
 * unusable either way.
 */
const byParent = (
  snapshots: readonly Snapshot[],
  byId: ReadonlyMap<string, readonly Snapshot[]>
) => {
  const roots: Snapshot[] = [];
  const followers: Snapshot[] = [];
  const problems: Problem[] = [];
  for (const snapshot of snapshots) {
    const [parent] = snapshot.prevIds;
    if (snapshot.prevIds.length !== 1 || parent === undefined) {
      problems.push({
        kind: "parents",
        name: snapshot.name,
        parents: snapshot.prevIds,
      });
    } else if (parent === NO_PARENT) {
      roots.push(snapshot);
    } else if (byId.has(parent)) {
      followers.push(snapshot);
    } else {
      problems.push({ kind: "unknown-parent", name: snapshot.name, parent });
    }
  }
  return { followers, problems, roots };
};

/** Folder names that sort against the order the chain puts them in. */
const misordered = (chain: readonly Snapshot[]): readonly Problem[] =>
  chain.flatMap((snapshot, index) => {
    const parent = chain[index - 1];
    return parent !== undefined && snapshot.name <= parent.name
      ? [
          {
            kind: "out-of-order" as const,
            name: snapshot.name,
            parent: parent.name,
          },
        ]
      : [];
  });

/**
 * Everything wrong with the chain the snapshots describe.
 *
 * Linear means four things at once, and each is checked separately so the
 * message names the actual fault: exactly one migration starts the chain, every
 * other names exactly one parent that exists, no two name the same parent, and
 * following the parents from the start reaches all of them. A chain that
 * satisfies all four is a path, which is why nothing here counts heads — one
 * falls out.
 */
export const findProblems = (
  migrations: readonly Migration[]
): readonly Problem[] => {
  const snapshots = migrations.filter(
    (migration) => migration.kind === "snapshot"
  );
  const byId = groupBy(snapshots, (snapshot) => snapshot.id);
  /** A parent id read back as the folder holding it, for the messages. */
  const nameOf = (id: string) => byId.get(id)?.[0]?.name ?? shortId(id);

  const sorted = byParent(snapshots, byId);
  const children = groupBy(sorted.followers, ({ prevIds }) => prevIds[0] ?? "");
  const chain = walk(sorted.roots, children);

  const problems: Problem[] = [
    ...migrations.filter((migration) => migration.kind === "unreadable"),
    ...shared(byId).map(([id, names]) => ({
      id,
      kind: "duplicate-id" as const,
      names,
    })),
    ...sorted.problems,
    ...shared(children).map(([parent, names]) => ({
      kind: "fork" as const,
      names,
      parent: nameOf(parent),
    })),
  ];
  if (sorted.roots.length !== 1) {
    problems.push({
      kind: "roots",
      names: sorted.roots.map(({ name }) => name),
    });
  }

  // Whatever a fork or a missing parent cut off is unreachable by definition,
  // and has already been named once. Only the migrations stranded behind one of
  // those are worth a second line — and only once there is a start to walk
  // from, since with no root or two every snapshot is unreachable at once.
  const named = new Set(problems.flatMap(namesIn));
  const detached = snapshots.filter(
    (snapshot) => !(chain.includes(snapshot) || named.has(snapshot.name))
  );
  if (sorted.roots.length === 1 && detached.length > 0) {
    problems.push({
      kind: "detached",
      names: detached.map(({ name }) => name),
    });
  }

  return [...problems, ...misordered(chain)];
};

/** The last migration in the chain: what the next `db:generate` diffs against. */
export const headOf = (
  migrations: readonly Migration[]
): Snapshot | undefined => {
  const snapshots = migrations.filter(
    (migration) => migration.kind === "snapshot"
  );
  const parents = new Set(snapshots.flatMap(({ prevIds }) => prevIds));
  const heads = snapshots.filter(({ id }) => !parents.has(id));
  return heads.length === 1 ? heads[0] : undefined;
};

/** One problem as a line an operator can act on. */
export const describeProblem = (problem: Problem): string => {
  switch (problem.kind) {
    case "unreadable":
      return `${problem.name}: ${problem.reason}`;
    case "missing-sql":
      return `${problem.name} has a snapshot but no migration.sql, so applying it would change nothing`;
    case "parents":
      return `${problem.name} names ${problem.parents.length} parents in prevIds; a migration follows exactly one`;
    case "duplicate-id":
      return `${list(problem.names)} share the snapshot id ${shortId(problem.id)} — the second was generated without the first in the tree`;
    case "unknown-parent":
      return `${problem.name} follows ${shortId(problem.parent)}, which no snapshot here has — its parent was renamed or deleted`;
    case "fork":
      return `${list(problem.names)} all follow ${problem.parent} — two branches generated on the same head and git merged both`;
    case "roots":
      return problem.names.length === 0
        ? "no migration starts the chain: none names the empty parent"
        : `${list(problem.names)} each start a chain; there can be only one`;
    case "detached":
      return `${list(problem.names)} cannot be reached from the first migration, so drizzle would never diff against them`;
    case "out-of-order":
      return `${problem.name} follows ${problem.parent} in the chain but sorts before it, so drizzle would apply the two the other way round`;
    // Unreachable while every variant is answered above, which is what the
    // annotation makes the compiler check; here so a new variant is a type
    // error rather than a silent blank line in the report.
    default:
      return problem satisfies never;
  }
};

/** What to do about any of it, which is the same thing in every case. */
const REMEDY =
  "Fix it by regenerating, not by editing a snapshot: delete the folder of the migration that came second, pull the other side into your branch, and run `bun run --cwd packages/db db:generate` again. A snapshot edited by hand stops describing the SQL beside it.";

const report = async (dir: string) => {
  const migrations = await readMigrations(dir);
  const problems = [
    ...findProblems(migrations),
    ...(await readMissingSql(dir, migrations)),
  ];

  if (problems.length === 0) {
    const head = headOf(migrations);
    process.stdout.write(
      `migrations-check: ${migrations.length} migrations, one chain, head ${head === undefined ? "unreadable" : head.name}\n`
    );
    return 0;
  }

  process.stderr.write(
    `migrations-check: the migration chain is broken in ${problems.length} ${problems.length === 1 ? "way" : "ways"}\n`
  );
  for (const problem of problems) {
    process.stderr.write(`  - ${describeProblem(problem)}\n`);
  }
  process.stderr.write(`\n${REMEDY}\n`);
  return 1;
};

if (import.meta.main) {
  process.exit(await report(MIGRATIONS_DIR));
}
