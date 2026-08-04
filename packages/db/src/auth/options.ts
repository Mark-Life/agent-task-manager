import { drizzleAdapter } from "@better-auth/drizzle-adapter/relations-v2";
import { type BetterAuthOptions, betterAuth } from "better-auth";
import { organization } from "better-auth/plugins/organization";
import {
  account,
  invitation,
  member,
  organization as organizationTable,
  session,
  user,
  verification,
} from "../schema/auth";

/**
 * A variable nobody filled in, treated as one nobody set. Effect's `Config`
 * already draws that line, and the two readers of this environment have to
 * agree about it — an empty origin here would be trusted as a literal origin
 * and match nothing, which reads from the outside as auth being broken.
 */
const configured = (value: string | undefined) =>
  value === undefined || value === "" ? undefined : value;

/**
 * The dashboard's exact origin — scheme and host, no path and no trailing
 * slash. Read from the environment rather than the typed config service because
 * this module is built at import time and the schema generator reads it with no
 * Effect runtime around it.
 *
 * A local run needs it as much as a deployed one, set to the dev server's own
 * address. Proxying the API through that server makes the two look same-origin
 * to application code, but the browser still sends the dev server's origin while
 * the proxy rewrites the host to the gateway's, so nothing matches until this
 * says so.
 */
const dashboardOrigin = configured(process.env.DASHBOARD_ORIGIN);

/**
 * The registrable domain the dashboard and the gateway share, written with its
 * leading dot — `.example.com` for `dash.example.com` and `api.example.com`.
 * Set, the session cookie is scoped to that domain and stays first-party in
 * every browser; unset, it stays on the gateway's own host, which is the right
 * answer for a local run and for a deployment served from one origin.
 */
const cookieDomain = configured(process.env.AUTH_COOKIE_DOMAIN);

/**
 * A cookie domain with no base URL is refused here, at import, because nothing
 * downstream would refuse it: Better Auth's own guard only fires when it cannot
 * derive a domain, and the domain below is always spelled out — it has to be,
 * since the library's default is the API's bare host, which the dashboard's
 * host never sees. Without a base URL the library also cannot tell it is
 * serving https, so what it would issue instead is a session token for the
 * whole domain with no `Secure` flag.
 */
if (
  cookieDomain !== undefined &&
  configured(process.env.BETTER_AUTH_URL) === undefined
) {
  throw new Error("AUTH_COOKIE_DOMAIN requires BETTER_AUTH_URL to be set.");
}

/**
 * Widening the cookie is opt-in: the whole block is absent when nobody asked
 * for it, which is the right answer for a local run and for a deployment
 * served from a single origin.
 */
const crossSubDomainCookies =
  cookieDomain === undefined
    ? undefined
    : { domain: cookieDomain, enabled: true };

/**
 * Everything about auth that does not depend on a live database handle, kept
 * apart so the schema generator can read it without one. The export is named
 * `options` because that is the property the Better Auth CLI looks for on the
 * module it is pointed at.
 *
 * A workspace is an organization: the plugin already owns membership, roles and
 * invitations, and every one of our tables carries the organization id as its
 * `workspace_id`.
 *
 * There is one operator and one way in: a password, on an account a bootstrap
 * script created. Sign-up stays shut, so the set of people who can reach this
 * system is a decision somebody made at the console rather than a form anyone
 * can fill in. Neither `secret` nor `baseURL` appears here — the library reads
 * `BETTER_AUTH_SECRET` and `BETTER_AUTH_URL` from the environment itself, and
 * naming them twice is a way for the two spellings to drift.
 */
export const options = {
  advanced: {
    crossSubDomainCookies,
    database: {
      // The drizzle adapter can resolve a relation in the same round trip
      // instead of a follow-up query per row.
      joins: true,
    },
    // A cookie scoped to the whole domain is a session token every host under
    // it can be asked for, so it is never issued without `Secure` — not even
    // behind a base URL that says http. Left to the library where the cookie
    // stays on one host: there its default (https base URL, or production)
    // is right, and forcing `false` here would undo it.
    useSecureCookies: cookieDomain === undefined ? undefined : true,
  },
  appName: "agent-task-manager",
  emailAndPassword: {
    disableSignUp: true,
    enabled: true,
  },
  plugins: [organization()],
  // Better Auth checks `Origin` on every non-GET that carries a cookie and
  // answers 403 to anything it was not told about. Its base URL's own origin is
  // already trusted, so this list is the dashboard and nothing else.
  trustedOrigins: dashboardOrigin === undefined ? [] : [dashboardOrigin],
} satisfies BetterAuthOptions;

/**
 * Builds the auth instance over a drizzle handle the caller already owns, so the
 * promise-based handle Better Auth needs and our Effect one share a single
 * connection pool. The server that mounts the handler passes its own handle in;
 * nothing here opens a connection.
 */
/**
 * The tables the adapter is allowed to reach, keyed by the model names Better
 * Auth asks for. Passed explicitly because the adapter otherwise falls back to
 * `db._.fullSchema`, which drizzle v1 does not populate — a v1 handle carries
 * `relations` instead, so the lookup finds nothing and the adapter refuses to
 * initialize.
 *
 * Naming only these seven is the useful part of having to pass them: the
 * adapter is a generic model-keyed way into the database, and this is the list
 * of what it can address.
 */
const authSchema = {
  account,
  invitation,
  member,
  organization: organizationTable,
  session,
  user,
  verification,
};

export const makeAuth = (db: Parameters<typeof drizzleAdapter>[0]) =>
  betterAuth({
    ...options,
    database: drizzleAdapter(db, { provider: "pg", schema: authSchema }),
  });
