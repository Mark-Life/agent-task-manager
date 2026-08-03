#!/usr/bin/env bun

/**
 * Giving a real person a way in, from the console.
 *
 * Sign-up is closed — `emailAndPassword.disableSignUp` in the auth options — so
 * no form will ever create an account here and no invitation can be mailed,
 * because nothing on this host sends mail. The seed makes exactly one login,
 * `owner@agent-task-manager.local`, which is a placeholder rather than an
 * address anybody owns. This script is what turns that into an operator with
 * their own email, and what adds a second person later.
 *
 * Everything it writes goes through the auth library's own adapter rather than
 * an insert, so the ids, the password hash and the membership row are minted
 * the way a sign-up would have minted them and a later sign-in recognizes them.
 *
 * Re-runnable in every part: an existing user is found rather than duplicated,
 * an existing password is left alone — a rotation is not undone by running this
 * again — and an existing membership is not written twice.
 *
 *     USER_PASSWORD='...' bun run user:add --email me@example.com --name Me
 *
 * The password comes from the environment rather than a flag so it stays out of
 * the shell history and out of `ps`. Without one the account is created with no
 * way to sign in, which is what a placeholder for an invitee looks like.
 */

import { BunRuntime } from "@effect/platform-bun";
import { Auth, ensurePassword, storeLayer, WorkspaceRepo } from "@workspace/db";
import type { Workspace } from "@workspace/domain";
import { Config, type Context, Effect, Option, Schema } from "effect";

/** Reported as `application_name`, so `pg_stat_activity` names this process. */
const APPLICATION_NAME = "user-add";

/** The workspace the seed creates, and the one a single-operator host has. */
const DEFAULT_WORKSPACE_SLUG = "personal";

/**
 * The roles the organization plugin defines. Listed here so `--role` is checked
 * against them before anything is written: the endpoint would reject an unknown
 * one, but only after the user row exists, which leaves an account behind that
 * belongs to no workspace.
 */
const ROLES = ["owner", "admin", "member"] as const;

type Role = (typeof ROLES)[number];

/**
 * What a new member is unless told otherwise. There is one person here and the
 * board is theirs; a narrower role is a decision for the day a second person
 * arrives, and `--role` is how it gets made.
 */
const DEFAULT_ROLE: Role = "owner";

/**
 * Where a password is changed, which is not anywhere a person can click.
 *
 * The dashboard has four routes — the board, a task, the project list and the
 * sign-in page — and no account screen among them. The auth library still
 * serves `/api/auth/change-password` to a caller holding a session, so that is
 * the rotation path until a screen exists, and saying so beats implying a
 * button that is not there.
 */
const ROTATE_HINT =
  "rotate with POST /api/auth/change-password, carrying that session's cookie";

/** The built auth instance, as the service hands it over. */
type AuthInstance = Context.Service.Shape<typeof Auth>;

/** The script was told to do something it cannot. */
class BadUsage extends Schema.TaggedErrorClass<BadUsage>()("UserAdd.BadUsage", {
  detail: Schema.String,
}) {}

/** One `--flag value` pair off the argument list, or nothing. */
const flag = (argv: readonly string[], name: string) => {
  const at = argv.indexOf(`--${name}`);
  return at === -1 ? undefined : argv[at + 1];
};

/**
 * The workspace to add the person to: the one named by slug or by id, or the
 * `personal` one the seed makes. Named rather than guessed when several exist,
 * because the wrong choice here is an account that signs in and sees an empty
 * board it has no way to leave.
 */
const workspaceOf = (named: string | undefined) =>
  Effect.gen(function* () {
    const workspaces = yield* WorkspaceRepo;
    const all = yield* workspaces.list();
    const wanted = named ?? DEFAULT_WORKSPACE_SLUG;

    const found = all.find(
      (workspace) => workspace.slug === wanted || workspace.id === wanted
    );
    if (found !== undefined) {
      return found;
    }

    const known = all.map((workspace) => workspace.slug).join(", ");
    return yield* Effect.fail(
      new BadUsage({
        detail:
          all.length === 0
            ? "no workspace exists — run `bun run db:seed` first"
            : `no workspace "${wanted}" — this database has ${known}`,
      })
    );
  });

/**
 * The account, created if this database has never seen the address.
 *
 * Goes through the internal adapter for the same reason the seed does: the id
 * is minted the way every other account's is, and the library's own hooks run.
 */
const account = (auth: AuthInstance, email: string, name: string) =>
  Effect.tryPromise(async () => {
    const context = await auth.$context;
    const found = await context.internalAdapter.findUserByEmail(email);
    if (found !== null) {
      return { created: false, user: found.user };
    }
    const user = await context.internalAdapter.createUser(
      { email, name },
      { method: "admin" }
    );
    return { created: true, user };
  });

/**
 * The membership row that makes the workspace theirs, written once.
 *
 * `addMember` is called with no request headers, which is how the library
 * recognizes a server-side call — there is no browser session to read and a
 * script is not one. The existing-membership check is ours because the
 * endpoint that would answer it, `listMembers`, requires headers.
 */
const membership = (options: {
  readonly auth: AuthInstance;
  readonly role: Role;
  readonly userId: string;
  readonly workspaceId: string;
}) =>
  Effect.tryPromise(async () => {
    const { auth, role, userId, workspaceId } = options;
    const context = await auth.$context;
    const existing = await context.adapter.findMany<{ readonly role: string }>({
      model: "member",
      where: [
        { field: "organizationId", value: workspaceId },
        { field: "userId", value: userId },
      ],
    });

    const [already] = existing;
    if (already !== undefined) {
      return `already a ${already.role} of the workspace — left as it is`;
    }

    await auth.api.addMember({
      body: { organizationId: workspaceId, role, userId },
    });
    return `added to the workspace as ${role}`;
  });

/**
 * The password, if the environment names one.
 *
 * Optional on purpose: an account with no credential is a placeholder somebody
 * can be given a password for later, and it is also what a second person looks
 * like before they have chosen one.
 */
const credential = (auth: AuthInstance, userId: string) =>
  Effect.gen(function* () {
    const configured = yield* Config.option(Config.redacted("USER_PASSWORD"));
    if (Option.isNone(configured)) {
      return "no USER_PASSWORD — the account exists but cannot sign in yet";
    }
    const outcome = yield* ensurePassword({
      auth,
      password: configured.value,
      userId,
    });
    return outcome === "linked"
      ? "password set — this account can sign in"
      : `password already set — left as it is; ${ROTATE_HINT}`;
  });

/**
 * What the operator has to copy somewhere else.
 *
 * The bot's allowlist is the reason: `TELEGRAM_ALLOWLIST` is
 * `telegramUserId:workspaceId:userId`, and two of those three are ids that
 * exist nowhere a person can read them off. Printing the entry with the
 * Telegram half left as a placeholder is cheaper than explaining where to find
 * the other two.
 */
const summary = (options: {
  readonly userId: string;
  readonly workspace: Workspace;
}) =>
  [
    `userId       ${options.userId}`,
    `workspaceId  ${options.workspace.id}`,
    "",
    "TELEGRAM_ALLOWLIST entry, once you know your Telegram user id:",
    `  <telegramUserId>:${options.workspace.id}:${options.userId}`,
  ].join("\n");

const program = Effect.gen(function* () {
  const argv = process.argv.slice(2);

  const email = flag(argv, "email");
  if (email === undefined) {
    return yield* Effect.fail(
      new BadUsage({ detail: "--email names the account to create" })
    );
  }

  const workspace = yield* workspaceOf(flag(argv, "workspace"));
  const auth = yield* Auth;

  // The address is the identity; a display name is decoration, and defaulting
  // it to the local part beats refusing to create an account over it.
  const name = flag(argv, "name") ?? email.split("@")[0] ?? email;

  const named = flag(argv, "role");
  const role = ROLES.find((known): known is Role => known === named);
  if (named !== undefined && role === undefined) {
    return yield* Effect.fail(
      new BadUsage({ detail: `--role must be one of ${ROLES.join(", ")}` })
    );
  }

  const { created, user } = yield* account(auth, email, name);
  yield* Effect.logInfo(
    created ? `created ${email}` : `${email} already exists — reusing it`
  );

  yield* Effect.logInfo(yield* credential(auth, user.id));
  yield* Effect.logInfo(
    yield* membership({
      auth,
      role: role ?? DEFAULT_ROLE,
      userId: user.id,
      workspaceId: workspace.id,
    })
  );

  yield* Effect.sync(() =>
    process.stdout.write(`\n${summary({ userId: user.id, workspace })}\n`)
  );
});

if (import.meta.main) {
  BunRuntime.runMain(
    program.pipe(
      // The tag alone reads as `UserAdd.BadUsage:` with nothing after it, and a
      // usage error whose text is missing is worse than no check at all.
      Effect.tapError((error) =>
        Effect.sync(() => {
          if (error._tag === "UserAdd.BadUsage") {
            process.stderr.write(`${error.detail}\n`);
          }
        })
      ),
      Effect.provide(storeLayer({ applicationName: APPLICATION_NAME }))
    )
  );
}
