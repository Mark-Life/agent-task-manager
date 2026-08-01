import { makeAuth } from "./options";

/**
 * The target the Better Auth schema generator is pointed at. It reads the plugin
 * list and the adapter off a built instance — a configured adapter is what makes
 * it emit drizzle v1 `defineRelationsPart` rather than the legacy `relations()`
 * helper — and it issues no query while doing so, which is why the handle here is
 * empty. Nothing but the generator may import this module: the instance it holds
 * cannot reach a database.
 *
 * The generator is pinned to the same release as the runtime in `auth:generate`,
 * and not to a floating tag: it emits the table definitions and the drizzle
 * relations this package then runs against, so a newer one would quietly write
 * a schema for a library version we are not using.
 */
export const auth = makeAuth({});
