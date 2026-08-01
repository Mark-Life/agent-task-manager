/**
 * The workspace every other row hangs off, and the owner it belongs to.
 *
 * Both are the auth library's rows — `organization` is what this system calls a
 * workspace, and `user` is the human — so neither is written directly here.
 * They are created through the library's own server API, which is the only way
 * that keeps its ids, its hooks and its membership row consistent with what a
 * later login will expect.
 *
 * Reading is the other way round: the workspace comes back through our own
 * repository, so what a script goes on to use has been decoded into the domain
 * type like any other row rather than trusted straight off the library.
 */

import { Auth, WorkspaceRepo } from "@workspace/db";
import { UserId } from "@workspace/domain";
import { type Context, Effect, Schema } from "effect";

/**
 * The workspace the seed creates and every script reuses. The slug is the
 * identity: running a script twice finds this one instead of failing on the
 * unique index behind it, which is what makes the seed re-runnable.
 */
const WORKSPACE_NAME = "Personal";
const WORKSPACE_SLUG = "personal";

/**
 * The account the workspace belongs to. A local address on purpose — nothing
 * mails it, and the first real login links to this row rather than creating a
 * second owner.
 */
const OWNER_EMAIL = "owner@agent-task-manager.local";
const OWNER_NAME = "Owner";

/**
 * The auth library accepted the write and the workspace is still not there.
 * Named rather than swallowed: everything downstream needs a workspace id, and
 * an empty result here would surface as a foreign key violation three writes
 * later.
 */
export class WorkspaceMissing extends Schema.TaggedErrorClass<WorkspaceMissing>()(
  "Seed.WorkspaceMissing",
  { slug: Schema.String }
) {}

/** The built auth instance, as the service hands it over. */
type AuthInstance = Context.Service.Shape<typeof Auth>;

/**
 * The owner account, created if this database has never seen it. Goes through
 * the library's internal adapter rather than an insert, so the id is minted the
 * way every other account's is.
 */
const ownerAccount = (auth: AuthInstance) =>
  Effect.tryPromise(async () => {
    const context = await auth.$context;
    const found = await context.internalAdapter.findUserByEmail(OWNER_EMAIL);
    if (found !== null) {
      return found.user;
    }
    return await context.internalAdapter.createUser(
      { email: OWNER_EMAIL, name: OWNER_NAME },
      { method: "admin" }
    );
  });

/**
 * Creates the organization on behalf of the owner. Passing `userId` with no
 * request headers is how the library recognizes a server-side call: there is no
 * browser session to read, and a script is not one.
 */
const createWorkspace = (auth: AuthInstance, ownerId: string) =>
  Effect.tryPromise(() =>
    auth.api.createOrganization({
      body: { name: WORKSPACE_NAME, slug: WORKSPACE_SLUG, userId: ownerId },
    })
  );

/**
 * The workspace and its owner, creating either if this is a fresh database.
 * Idempotent, so a script can be run again after a failure halfway through.
 */
export const ensureWorkspace = Effect.fn("Seed.ensureWorkspace")(function* () {
  const workspaces = yield* WorkspaceRepo;
  const auth = yield* Auth;

  const owner = yield* ownerAccount(auth);
  const ownerId = UserId.make(owner.id);

  const bySlug = (found: { readonly slug: string }) =>
    found.slug === WORKSPACE_SLUG;

  const existing = (yield* workspaces.list()).find(bySlug);
  if (existing !== undefined) {
    return { owner: ownerId, workspace: existing };
  }

  yield* createWorkspace(auth, ownerId);

  // Re-read rather than decode what the library handed back: one schema owns
  // what a workspace is on the way in, and this is it.
  const created = (yield* workspaces.list()).find(bySlug);
  if (created === undefined) {
    return yield* Effect.fail(new WorkspaceMissing({ slug: WORKSPACE_SLUG }));
  }

  return { owner: ownerId, workspace: created };
});
