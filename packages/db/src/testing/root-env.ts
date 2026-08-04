/**
 * Puts the repository's `.env` into the environment before any test module is
 * loaded.
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
 * is already too late if an earlier file read a config.
 *
 * Nothing already set is overwritten, so `DATABASE_URL=... bun test` still
 * wins, and a missing `.env` is not an error: the environment is then whatever
 * the caller exported.
 */

import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import process from "node:process";

/** Where the repository's `.env` sits, relative to this file. */
const ENV_PATH = resolve(import.meta.dirname, "../../../../.env");

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

loadRootEnv();
