/**
 * Giving an existing person a password, which is the one auth write no route
 * can make here.
 *
 * Sign-up is closed, so the library's own `/sign-up/email` — the code that
 * normally hashes a password and files the account row beside the user — is
 * unreachable. A bootstrap script therefore has to make the same three writes
 * itself, and it makes them through the library's internal adapter rather than
 * against the table, so the id, the issuer and the hash are minted exactly the
 * way a sign-up would have minted them and a later sign-in recognizes the row.
 */

import { createLocalAccountIssuer } from "better-auth/db";
import { type Context, Effect, Redacted } from "effect";
import type { Auth } from "../client";

/** The provider a password lives under, and the issuer the library derives from it. */
const CREDENTIAL_PROVIDER = "credential";
const CREDENTIAL_ISSUER = createLocalAccountIssuer(CREDENTIAL_PROVIDER);

/** The built auth instance, as the service hands it over. */
type AuthInstance = Context.Service.Shape<typeof Auth>;

/** What the write turned out to be, so a caller can say which one happened. */
export type PasswordOutcome = "already_set" | "linked";

/**
 * Gives a user a password if they have none, and leaves an existing one alone.
 *
 * Both halves matter. Scripts here are re-runnable by design, so a second run
 * must not fail on the row the first one wrote; and a password already in place
 * may have been rotated by the person using it, which a bootstrap value would
 * silently roll back. The password stays {@link Redacted.Redacted} up to the
 * call that hashes it, so nothing on the way in can log it.
 */
export const ensurePassword = Effect.fn("Db.ensurePassword")(
  function* (options: {
    readonly auth: AuthInstance;
    readonly password: Redacted.Redacted<string>;
    readonly userId: string;
  }) {
    const { auth, password, userId } = options;
    return yield* Effect.tryPromise(async (): Promise<PasswordOutcome> => {
      const context = await auth.$context;
      const accounts = await context.internalAdapter.findAccounts(userId);
      const existing = accounts.find(
        (account) =>
          account.providerId === CREDENTIAL_PROVIDER &&
          account.issuer === CREDENTIAL_ISSUER
      );
      if (existing !== undefined) {
        return "already_set";
      }
      await context.internalAdapter.linkAccount({
        issuer: CREDENTIAL_ISSUER,
        password: await context.password.hash(Redacted.value(password)),
        providerAccountId: userId,
        providerId: CREDENTIAL_PROVIDER,
        userId,
      });
      return "linked";
    });
  }
);
