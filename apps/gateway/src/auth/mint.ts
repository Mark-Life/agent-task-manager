/**
 * Handing out a machine credential, from the command line.
 *
 * Tokens are signed, not stored, so there is no admin screen that could issue
 * one and no table to insert into — the only way to a token is the secret, and
 * the only thing holding the secret is a process on the box. That is this
 * script. It exists because the Executor connector, `curl` and the manager
 * agent all need a bearer token before any of them can say a word, and telling
 * an operator to write one by hand would mean telling them the signing format.
 *
 * A worker run's token is deliberately not mintable here: it is bound to a
 * task, a run and a session that only exist once the orchestrator has opened
 * them, so it is minted at dispatch and never by a person.
 *
 *     bun run apps/gateway/src/auth/mint.ts --scope read --user me --ttl-days 30
 */

import { BunRuntime } from "@effect/platform-bun";
import { API_SCOPES, type ApiScope } from "@workspace/api";
import { storeLayer, WorkspaceRepo } from "@workspace/db";
import { Actor, UserId, WorkspaceId } from "@workspace/domain";
import { Duration, Effect, Schema } from "effect";
import { SERVICE_NAME } from "../identity";
import { makeTokenSigner } from "./tokens";

/** Long enough to configure a connector with, short enough to be worth rotating. */
const DEFAULT_TTL_DAYS = 30;

/** The default scope: reading is what an integration should be given first. */
const DEFAULT_SCOPE: ApiScope = "read";

/** The script was told to do something it cannot. */
class BadUsage extends Schema.TaggedErrorClass<BadUsage>()(
  "MintToken.BadUsage",
  {
    detail: Schema.String,
  }
) {}

/** One `--flag value` pair off the argument list, or nothing. */
const flag = (argv: readonly string[], name: string) => {
  const at = argv.indexOf(`--${name}`);
  return at === -1 ? undefined : argv[at + 1];
};

/**
 * The workspace to mint for: the one named, or the only one there is. Guessing
 * between several would hand out a credential for the wrong board.
 */
const workspaceOf = (named: string | undefined) =>
  Effect.gen(function* () {
    if (named !== undefined) {
      return WorkspaceId.make(named);
    }
    const workspaces = yield* WorkspaceRepo;
    const all = yield* workspaces.list();
    const [only] = all;
    if (all.length !== 1 || only === undefined) {
      return yield* Effect.fail(
        new BadUsage({
          detail: `${all.length} workspaces exist — name one with --workspace`,
        })
      );
    }
    return only.id;
  });

/** Reads the arguments, mints, and prints the token and nothing else. */
const program = Effect.gen(function* () {
  const argv = process.argv.slice(2);

  const named = flag(argv, "scope") ?? DEFAULT_SCOPE;
  const scope = API_SCOPES.find((known): known is ApiScope => known === named);
  if (scope === undefined) {
    return yield* Effect.fail(
      new BadUsage({
        detail: `--scope must be one of ${API_SCOPES.join(", ")}`,
      })
    );
  }

  const user = flag(argv, "user");
  if (user === undefined) {
    return yield* Effect.fail(
      new BadUsage({ detail: "--user names whom the token acts as" })
    );
  }

  // A person's token may reach the destructive end; an agent speaking for one
  // may not, and the signer refuses to mint above that ceiling either way.
  const actor =
    flag(argv, "kind") === "manager"
      ? Actor.cases.manager.make({ userId: UserId.make(user) })
      : Actor.cases.human.make({ userId: UserId.make(user) });

  const days = Number(flag(argv, "ttl-days") ?? DEFAULT_TTL_DAYS);
  if (!Number.isFinite(days) || days <= 0) {
    return yield* Effect.fail(
      new BadUsage({ detail: "--ttl-days must be a positive number of days" })
    );
  }

  const workspaceId = yield* workspaceOf(flag(argv, "workspace"));
  const tokens = yield* makeTokenSigner;
  const token = yield* tokens.mint({
    actor,
    scope,
    ttl: Duration.days(days),
    workspaceId,
  });

  yield* Effect.sync(() => process.stdout.write(`${token}\n`));
});

if (import.meta.main) {
  BunRuntime.runMain(
    program.pipe(
      // The tag alone reads as `MintToken.BadUsage:` with nothing after it, and
      // a usage error whose text is missing is worse than no check at all.
      Effect.tapError((error) =>
        Effect.logError(
          error._tag === "MintToken.BadUsage"
            ? error.detail
            : `could not mint: ${error._tag}`
        )
      ),
      Effect.provide(storeLayer({ applicationName: SERVICE_NAME }))
    )
  );
}
