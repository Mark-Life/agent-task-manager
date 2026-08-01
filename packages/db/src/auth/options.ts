import { drizzleAdapter } from "@better-auth/drizzle-adapter/relations-v2";
import { type BetterAuthOptions, betterAuth } from "better-auth";
import { organization } from "better-auth/plugins/organization";

/**
 * Everything about auth that does not depend on a live database handle, kept
 * apart so the schema generator can read it without one. The export is named
 * `options` because that is the property the Better Auth CLI looks for on the
 * module it is pointed at.
 *
 * A workspace is an organization: the plugin already owns membership, roles and
 * invitations, and every one of our tables carries the organization id as its
 * `workspace_id`.
 */
export const options = {
  advanced: {
    database: {
      // The drizzle adapter can resolve a relation in the same round trip
      // instead of a follow-up query per row.
      joins: true,
    },
  },
  appName: "agent-task-manager",
  plugins: [organization()],
} satisfies BetterAuthOptions;

/**
 * Builds the auth instance over a drizzle handle the caller already owns, so the
 * promise-based handle Better Auth needs and our Effect one share a single
 * connection pool. The server that mounts the handler passes its own handle in;
 * nothing here opens a connection.
 */
export const makeAuth = (db: Parameters<typeof drizzleAdapter>[0]) =>
  betterAuth({
    ...options,
    database: drizzleAdapter(db, { provider: "pg" }),
  });
