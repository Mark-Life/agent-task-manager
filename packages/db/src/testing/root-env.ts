/**
 * Puts the repository's `.env` into the environment before any test module is
 * loaded, and then points the suite at a database of its own.
 *
 * Two facts make this a preload rather than a helper a test file calls.
 *
 * Bun reads `.env` from its working directory only, and turbo runs each
 * package's `test` script with that package as the working directory — so
 * `bun test` at the repository root sees `DATABASE_URL` and the same suite
 * under `turbo test` does not.
 *
 * Effect's default `ConfigProvider` snapshots `process.env` the first time
 * anything reads a `Config`, and the snapshot is cached on the context
 * reference for the life of the process. Under `bun test` every file shares one
 * process, so the first config read in the first test file decides what every
 * later file can see. A file that repairs `process.env` at its own module scope
 * is already too late if an earlier file read a config — which is exactly the
 * shape the repository tests were failing in.
 *
 * Nothing already set is overwritten while the file is read, and a missing
 * `.env` is not an error: the environment is then whatever the caller exported.
 *
 * The redirect afterwards is the exception, and the point of this module. Every
 * repository test here writes real rows, so whichever database `DATABASE_URL`
 * names is the one that collects them — and on this box that variable names the
 * live board. It did, once: four cards the suite filed are still on it. So the
 * last thing the preload does is overwrite `DATABASE_URL` with the test one,
 * even where the caller exported a value, because an exported production URL
 * is the accident rather than the instruction. `TEST_DATABASE_URL` is the one
 * knob that aims the suite somewhere by hand.
 *
 * This file is the only copy. The preloads under `apps/` and the other packages
 * import it, so there is one answer to which database a test writes to.
 */

import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import process from "node:process";

/** Where the repository's `.env` sits, relative to this file. */
const ENV_PATH = resolve(import.meta.dirname, "../../../../.env");

/**
 * What the test database is called, given the ordinary one: the same server,
 * the same credentials, a neighbouring database. Derived rather than configured
 * so that a checkout with nothing but `DATABASE_URL` set still keeps its tests
 * off the board — a default nobody has to know about is the only kind that
 * protects a machine nobody has configured.
 */
const TEST_DATABASE_SUFFIX = "_test";

/** The leading slash a connection string's path carries, and the name does not. */
const LEADING_SLASH = /^\//;

/** Splits one `KEY=value # comment` line, or nothing if the line carries none. */
const entryOf = (line: string) => {
  const at = line.indexOf("=");
  const key = line.slice(0, at).trim();
  if (at === -1 || key.length === 0 || key.startsWith("#")) {
    return null;
  }
  const value =
    line
      .slice(at + 1)
      .split(" #")[0]
      ?.trim() ?? "";
  return [key, value] as const;
};

/**
 * Reads the repository's `.env` into `process.env`, leaving every variable that
 * already has a value alone. Safe to call more than once.
 */
export const loadRootEnv = () => {
  if (!existsSync(ENV_PATH)) {
    return;
  }
  for (const line of readFileSync(ENV_PATH, "utf-8").split("\n")) {
    const entry = entryOf(line);
    if (entry !== null && process.env[entry[0]] === undefined) {
      process.env[entry[0]] = entry[1];
    }
  }
};

/** The connection string as a URL, or nothing if it is not one. */
const parseUrl = (url: string) => {
  try {
    return new URL(url);
  } catch {
    return null;
  }
};

/** The database a connection string names, which is its path and nothing else. */
const databaseNameOf = (url: URL) => url.pathname.replace(LEADING_SLASH, "");

/**
 * The neighbouring database a suite writes to, given the one an application
 * would use. Idempotent, so a URL that already names the test database is
 * returned unchanged and `bun run db:test` can be handed either.
 *
 * Anything that is not a URL with a database name in it comes back as it went
 * in: this runs before any test does, and failing here would turn a connection
 * string somebody typed oddly into a suite that cannot start with no hint why.
 * The suite then fails against whatever it was given, which is the same outcome
 * it had before this function existed.
 */
export const testDatabaseUrlOf = (url: string): string => {
  const parsed = parseUrl(url);
  if (parsed === null) {
    return url;
  }
  const name = databaseNameOf(parsed);
  if (name.length === 0 || name.endsWith(TEST_DATABASE_SUFFIX)) {
    return url;
  }
  parsed.pathname = `/${name}${TEST_DATABASE_SUFFIX}`;
  return parsed.toString();
};

/** A value the caller exported, or nothing when it is absent or empty. */
const set = (name: string) => {
  const value = process.env[name];
  return value === undefined || value.length === 0 ? null : value;
};

/**
 * Aims `DATABASE_URL` at the test database, and says which one on stderr — a
 * suite that writes rows should be legible about where it is writing them.
 *
 * `TEST_DATABASE_URL` wins outright; otherwise the name is derived. Unlike
 * everything above it, this overwrites a value the caller exported.
 */
export const useTestDatabase = () => {
  const named = set("TEST_DATABASE_URL");
  const ordinary = set("DATABASE_URL");
  const url = named ?? (ordinary === null ? null : testDatabaseUrlOf(ordinary));

  if (url === null) {
    return;
  }
  process.env.DATABASE_URL = url;
  const parsed = parseUrl(url);
  // The database name only. The rest of the string is a password.
  process.stderr.write(
    `tests → database ${parsed === null ? url : databaseNameOf(parsed)}\n`
  );
};

loadRootEnv();
useTestDatabase();
