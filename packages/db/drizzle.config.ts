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
  // Every table file, ours and the generated Better Auth one, lives here.
  schema: "./src/schema/**/*.ts",
});
