#!/usr/bin/env bun

/**
 * Makes the database the test suite writes to, and brings it up to the current
 * migration.
 *
 * There is one because the repository tests need real Postgres — the claims
 * they make are about what a transaction does, and a fake would only prove the
 * fake — and because before this existed the database they got was whichever
 * one `DATABASE_URL` named. On this box that is the live board, and it still
 * carries cards a test filed onto it in August.
 *
 * Which database that is comes from importing the suite's own preload rather
 * than from working it out again here: `@workspace/db/testing/root-env` reads
 * the repository `.env` and redirects `DATABASE_URL` to `<database>_test`, or
 * to `TEST_DATABASE_URL` when one is set. Importing it is what makes this
 * script prepare the database the suite will actually connect to, instead of a
 * second opinion about its name.
 *
 * Re-runnable, and cheap when there is nothing to do: an existing database is
 * left alone and `drizzle-kit migrate` skips what it has already applied.
 *
 * Usage: `bun run db:test`. `bun run test` does it first.
 */

import "@workspace/db/testing/root-env";
import { $ } from "bun";
import { Client } from "pg";

/** Where `drizzle-kit` and its migration folder live. */
const DB_PACKAGE = "packages/db";

/** The database every server has, so there is somewhere to run `create` from. */
const MAINTENANCE_DATABASE = "postgres";

/** Postgres for "that database is already there", which is not a failure here. */
const DUPLICATE_DATABASE = "42P04";

/** The leading slash a connection string's path carries, and the name does not. */
const LEADING_SLASH = /^\//;

const databaseNameOf = (target: URL) =>
  target.pathname.replace(LEADING_SLASH, "");

/**
 * Creates the database if it is not there, connected to the maintenance
 * database because `create database` cannot run inside the one it creates.
 *
 * Not `create database if not exists`, which Postgres does not have. The
 * duplicate is caught by its SQLSTATE instead, which is also what makes two of
 * these racing — turbo starts several test tasks at once — a no-op rather than
 * a failure.
 */
const ensureDatabase = async (target: URL) => {
  const name = databaseNameOf(target);
  const maintenance = new URL(target);
  maintenance.pathname = `/${MAINTENANCE_DATABASE}`;

  const client = new Client({ connectionString: maintenance.toString() });
  await client.connect();
  try {
    // `create database` takes no bind parameters, so the name is spliced. It
    // came from a connection string this machine already holds.
    await client.query(`create database "${name}"`);
    process.stdout.write(`created ${name}\n`);
  } catch (cause) {
    if ((cause as { code?: string }).code !== DUPLICATE_DATABASE) {
      throw cause;
    }
  } finally {
    await client.end();
  }
};

const redirected = process.env.DATABASE_URL;
if (redirected === undefined || redirected.length === 0) {
  process.stderr.write("DATABASE_URL is not set; see .env.example\n");
  process.exit(1);
}

const url = new URL(redirected);
await ensureDatabase(url);

// The CLI reads `DATABASE_URL` out of its own environment, and the preload has
// already made that the test database, so the migration lands where the suite
// will look for it.
await $`bun run --cwd ${DB_PACKAGE} --bun drizzle-kit migrate`;

process.stdout.write(`${databaseNameOf(url)} is up to date\n`);
