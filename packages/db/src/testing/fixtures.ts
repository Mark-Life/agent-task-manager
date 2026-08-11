/**
 * The workspace a test suite files into, which is never the one a person reads.
 *
 * The repository tests write real rows on purpose — every claim they make is
 * about what a transaction does to Postgres, and checking that against a fake
 * would be checking the fake. What they must not do is write those rows onto
 * somebody's board, and until this module existed the way each of them found a
 * workspace was `workspaces.list()[0]`: the first organization in whatever
 * database `DATABASE_URL` named. On this box that is the live board, and four
 * cards from an August run are still sitting on it.
 *
 * So a suite gets its own workspace here, created by its own name. Two walls,
 * and they are independent on purpose:
 *
 * - `./root-env` points the suite at a database of its own, so ordinarily none
 *   of this reaches the live one at all.
 * - A workspace per suite means that even a run aimed at the live database
 *   files into an organization no board renders, and — with
 *   `FIXTURE_METADATA` on the cards — into rows no column lists.
 *
 * Per suite rather than one shared fixture workspace because turbo runs each
 * package's tests as its own process, at the same time: a shared column would
 * hold another package's half-finished cards, and a test that reads a whole
 * column would be reading them.
 */

import {
  UserId,
  type UserId as UserIdType,
  type Workspace,
} from "@workspace/domain";
import { Effect, Schema } from "effect";
import { Auth } from "../client";
import { WorkspaceRepo } from "../repositories/workspace";

/** Everything a slug may hold; anything else in a suite name becomes a dash. */
const SLUG_UNSAFE = /[^a-z0-9]+/g;

/** Marks the organization as a suite's, wherever somebody is looking at rows. */
const SLUG_PREFIX = "fixtures-";

/**
 * The auth library made the organization and then it was not there to read.
 * Its own creation path is the only writer, so this is not a case a test can
 * recover from by writing the row itself.
 */
export class FixtureWorkspaceMissing extends Schema.TaggedErrorClass<FixtureWorkspaceMissing>()(
  "Testing.FixtureWorkspaceMissing",
  { slug: Schema.String }
) {}

/** What a suite's fixture workspace and its owner are called. */
const namesOf = (suite: string) => {
  const slug = `${SLUG_PREFIX}${suite.toLowerCase().replace(SLUG_UNSAFE, "-")}`;
  return {
    // `.invalid` is reserved by RFC 2606 and resolves nowhere, so a fixture
    // owner is an address nothing could ever deliver to by accident.
    email: `${slug}@fixtures.invalid`,
    name: `Fixtures: ${suite}`,
    slug,
  } as const;
};

/**
 * The suite's owner, created if this is the first run against this database.
 *
 * Through `internalAdapter` rather than the sign-up API because there is no
 * password and no session here: the user exists to be named by `createdBy` and
 * by the audit rows, and giving a fixture a credential would be giving a
 * fixture a way in.
 */
const ownerOf = (suite: string) =>
  Effect.gen(function* () {
    const auth = yield* Auth;
    const { email, name } = namesOf(suite);

    const user = yield* Effect.tryPromise(async () => {
      const context = await auth.$context;
      const found = await context.internalAdapter.findUserByEmail(email);
      if (found !== null && found !== undefined) {
        return found.user;
      }
      return await context.internalAdapter.createUser(
        { email, name },
        { method: "admin" }
      );
    }).pipe(
      // Two packages' suites start at once against a fresh test database and
      // both find nothing: the loser of that race hits the unique index on the
      // email, and what it wanted is by then a row it can read.
      Effect.catch(() =>
        Effect.tryPromise(async () => {
          const context = await auth.$context;
          const found = await context.internalAdapter.findUserByEmail(email);
          if (found === null || found === undefined) {
            throw new Error(`no fixture owner for ${suite}`);
          }
          return found.user;
        })
      )
    );

    return UserId.make(user.id);
  });

/**
 * The workspace this suite files into, created on first use and reused after.
 * Idempotent, and safe against another package's suite doing the same thing at
 * the same moment.
 *
 * `suite` names the test file or package, and is what the organization is
 * called — so a row left behind in the test database says which suite left it.
 */
export const ensureFixtureWorkspace = Effect.fn("Testing.fixtureWorkspace")(
  function* (options: { readonly suite: string }) {
    const workspaces = yield* WorkspaceRepo;
    const auth = yield* Auth;
    const { name, slug } = namesOf(options.suite);

    const owner = yield* ownerOf(options.suite);
    const found = () =>
      Effect.map(workspaces.list(), (all) =>
        all.find((workspace) => workspace.slug === slug)
      );

    const existing = yield* found();
    if (existing !== undefined) {
      return { owner, workspace: existing } satisfies FixtureWorkspace;
    }

    // The create is allowed to fail: the loser of a race between two processes
    // fails on the slug's unique index, and the read below is what both of them
    // actually wanted.
    yield* Effect.tryPromise(() =>
      auth.api.createOrganization({ body: { name, slug, userId: owner } })
    ).pipe(Effect.ignore);

    // Re-read rather than decode what the library handed back: one schema owns
    // what a workspace is on the way in, and it is `WorkspaceRepo`'s.
    const created = yield* found();
    if (created === undefined) {
      return yield* new FixtureWorkspaceMissing({ slug });
    }
    return { owner, workspace: created } satisfies FixtureWorkspace;
  }
);

/** A suite's own workspace and the user its writes are attributed to. */
export interface FixtureWorkspace {
  readonly owner: UserIdType;
  readonly workspace: Workspace;
}
