import { apiKey } from "@better-auth/api-key";
import { drizzleAdapter } from "@better-auth/drizzle-adapter/relations-v2";
import { type BetterAuthOptions, betterAuth } from "better-auth";
import { organization } from "better-auth/plugins/organization";
import {
  account,
  apikey,
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
 * The dashboard's origins — scheme and host each, no path and no trailing
 * slash, comma-separated where there is more than one. Read from the
 * environment rather than the typed config service because this module is built
 * at import time and the schema generator reads it with no Effect runtime
 * around it.
 *
 * A local run needs it as much as a deployed one, set to the dev server's own
 * address. Proxying the API through that server makes the two look same-origin
 * to application code, but the browser still sends the dev server's origin while
 * the proxy rewrites the host to the gateway's, so nothing matches until this
 * says so. A dev server reached over the network is a second origin for the
 * same dashboard — `http://localhost:5173,http://192.168.1.10:5173` keeps both
 * ways in, and the first entry stays the one links are built from.
 */
const dashboardOrigins = (configured(process.env.DASHBOARD_ORIGIN) ?? "")
  .split(",")
  .map((origin) => origin.trim())
  .filter((origin) => origin !== "");

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
 * What a user-issued API key looks like on the wire. Keys are prefixed so a
 * value found in a log, a shell history or a paste is recognisable as this
 * system's — and distinguishable at a glance from the signed bearer token an
 * agent run carries, which is a different credential with a different lifetime.
 */
export const API_KEY_PREFIX = "atm_";

/**
 * How much of a key is kept in plain text for the dashboard to show. Long
 * enough that two keys issued minutes apart are told apart by eye, short enough
 * that the stored fragment is worth nothing to whoever reads the table.
 */
const API_KEY_START_LENGTH = 10;

/**
 * The ceiling on one key's traffic, and the window it is measured over. The
 * plugin's own default is ten requests a *day*, which would make every key
 * anybody issued look broken within a minute of being pointed at the board.
 *
 * Ten a second sustained is far above what an agent working a card does and far
 * below what a loop that has lost its exit condition does, which is the thing
 * worth stopping — a runaway integration hammering the board is the failure a
 * per-key limit is actually for.
 */
const API_KEY_RATE_WINDOW_MS = 60_000;
const API_KEY_RATE_MAX = 600;

/**
 * User-issued API keys, as the auth library implements them.
 *
 * Hashing, generation, expiry, revocation and the last-used timestamp are all
 * the plugin's — it stores a SHA-256 of the key and never the key itself, so
 * what is shown once at creation is genuinely the only copy, and `lastRequest`
 * is written by the same verification the gateway calls on every request.
 *
 * Three settings are load-bearing.
 *
 * **`enableMetadata`.** A key has to say what it is good for and which
 * workspace it speaks in, and metadata is the one field the plugin lets a
 * browser set at creation. It is therefore *untrusted input*: the gateway
 * checks the scope against the closed set and the workspace against the
 * issuer's live memberships, so a key naming a workspace its owner is not in
 * gets a 403 rather than a board.
 *
 * **`requireName`.** A key that cannot be identified in a list is a key nobody
 * revokes, and an un-revokable credential is the failure this whole feature is
 * meant to remove.
 *
 * **`enableSessionForAPIKeys` is left off**, which is the library's default and
 * is worth saying out loud: a key that mocked a session would be accepted by
 * the auth routes themselves, and among those routes is `/api-key/create`. A
 * key could then mint further keys — including one outliving its own
 * revocation. A key is a credential for the board's API and reaches nothing
 * else.
 */
const apiKeys = apiKey({
  defaultPrefix: API_KEY_PREFIX,
  enableMetadata: true,
  rateLimit: {
    enabled: true,
    maxRequests: API_KEY_RATE_MAX,
    timeWindow: API_KEY_RATE_WINDOW_MS,
  },
  requireName: true,
  startingCharactersConfig: {
    charactersLength: API_KEY_START_LENGTH,
    shouldStore: true,
  },
});

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
  plugins: [apiKeys, organization()],
  // Better Auth checks `Origin` on every non-GET that carries a cookie and
  // answers 403 to anything it was not told about. Its base URL's own origin is
  // already trusted, so this list is the dashboard and nothing else.
  trustedOrigins: dashboardOrigins,
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
 * Naming only these eight is the useful part of having to pass them: the
 * adapter is a generic model-keyed way into the database, and this is the list
 * of what it can address.
 */
const authSchema = {
  account,
  apikey,
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
