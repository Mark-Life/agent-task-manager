import { defineConfig } from "drizzle-kit";

/**
 * The CLI reads the connection string from the environment directly rather than
 * through the application's config layer: drizzle-kit is its own process, run by
 * hand before anything boots, so there is no Effect runtime to read from. A
 * missing value fails here instead of halfway through a migration.
 */
const databaseUrl = process.env.DATABASE_URL;

if (!databaseUrl) {
  throw new Error(
    "DATABASE_URL is not set. drizzle-kit needs it to reach Postgres; see .env.example."
  );
}

export default defineConfig({
  dbCredentials: { url: databaseUrl },
  dialect: "postgresql",
  // Migrations are checked in beside the schema that needs them, forward-only.
  out: "./drizzle",
  // The barrel, not a glob over the directory: a glob also picks up the
  // colocated tests, and drizzle-kit loads what it matches with node, which has
  // no `bun:test`. The barrel re-exports every table, ours and the generated
  // Better Auth ones, so it sees the same set either way.
  schema: "./src/schema/index.ts",
});
