/**
 * Turning a person's API key into the three facts every request resolves to.
 *
 * This is the adapter onto the auth library's API key plugin and nothing else.
 * It knows how a key is verified, what the plugin answers with, and how the two
 * things we asked it to carry — a scope and a workspace — are read back off the
 * row. What it deliberately does not know is how a refusal is filed or what a
 * refusal costs: it returns a verdict, and `./principal` turns that into the
 * status a caller sees and the row an operator counts.
 *
 * **A key is an on-behalf-of credential.** It resolves to the `human` actor of
 * the person who issued it, so everything it changes is attributed to them in
 * the audit trail exactly as if they had clicked it — which is the point of
 * pointing your own agent at the board with your own key. It is not, and must
 * never become, the credential the system's own agents hold: those are signed
 * tokens minted per run by the orchestrator, verified against the deployment's
 * secret, and they never touch this table. Revoking every key a person owns
 * therefore stops that person's integrations and no worker anywhere.
 *
 * **Two things on the key are untrusted.** The scope and the workspace ride in
 * the plugin's `metadata`, which is the one field a browser may write at
 * creation, so a key can claim anything. Both are checked here: the scope
 * against the ceiling a person holds, the workspace against the memberships
 * that person holds at this instant. A key naming a board its owner has been
 * removed from is refused on the next request rather than on the next login,
 * and a key belonging to a deleted user resolves to no workspace at all — which
 * is what makes deactivating somebody enough, without a sweep over their keys.
 */

import {
  ApiKeyMetadata,
  type ApiScope,
  type PrincipalShape,
  scopeReaches,
} from "@workspace/api";
import type { Auth, WorkspaceRepo } from "@workspace/db";
import { Actor, UserId, type WorkspaceId } from "@workspace/domain";
import { type Context, Effect, Option, Schema } from "effect";

/** The built auth instance, as the store hands it over. */
export type AuthInstance = Context.Service.Shape<typeof Auth>;

/** The membership read a key needs, which is the whole of what it needs. */
type Memberships = Pick<
  Context.Service.Shape<typeof WorkspaceRepo>,
  "membershipsOf"
>;

/**
 * What a person may do, and therefore the most any credential a person issues
 * may do.
 *
 * One constant with two readers. A signed-in session holds it directly, and a
 * key is refused if it was issued above it — so "a key carries its issuer's
 * permissions and no more" is a comparison against the same value rather than
 * two files that happen to agree. There is one role here today and it reaches
 * everything; the day a person can hold less than the whole board, this is
 * where that becomes true of their keys at the same moment it becomes true of
 * their session.
 */
export const USER_CEILING: ApiScope = "admin";

/** Why a key did not open the door, as the closed set the request event groups by. */
export const KEY_REASONS = {
  aboveCeiling: "key_above_ceiling",
  notAMember: "workspace_not_member",
  rejected: "key_rejected",
  spent: "key_rate_limited",
  unscoped: "key_unscoped",
} as const;

/**
 * The plugin's own codes for "this key is good but you have had enough". Both
 * are a quota rather than a credential problem, and both are the one refusal
 * whose repair is to wait.
 */
const SPENT_CODES: ReadonlySet<string> = new Set([
  "RATE_LIMITED",
  "USAGE_EXCEEDED",
]);

/**
 * What a key turned out to be. Three outcomes rather than two, because a spent
 * quota is a different answer to the caller than a bad key and telling them
 * apart is the only reason the plugin's rate limiting is worth having on.
 */
export type ApiKeyVerdict =
  | { readonly kind: "resolved"; readonly principal: PrincipalShape }
  | {
      readonly kind: "refused";
      readonly forbidden: boolean;
      readonly reason: string;
    }
  | { readonly kind: "spent"; readonly reason: string };

/** Everything the resolution reads, so a request pays for none of the construction. */
export interface ApiKeyOptions {
  readonly auth: AuthInstance;
  readonly key: string;
  readonly workspaces: Memberships;
}

const refused = (reason: string, forbidden = false): ApiKeyVerdict => ({
  forbidden,
  kind: "refused",
  reason,
});

/** The metadata a key was issued with, or nothing when it is not what we write. */
const metadataOf = (metadata: unknown) =>
  Schema.decodeUnknownEffect(ApiKeyMetadata)(metadata).pipe(
    Effect.option,
    Effect.map(Option.getOrNull)
  );

/**
 * Whether this workspace is one the issuer may still see. A membership read
 * rather than a claim on the key, for the reason the module header gives.
 *
 * A database that cannot answer dies rather than refusing: "we could not check"
 * and "you are not a member" are different facts, and answering the first with
 * the second would turn an outage into a wave of 403s that read as somebody
 * having lost their access.
 */
const isMember = (options: {
  readonly userId: UserId;
  readonly workspaceId: WorkspaceId;
  readonly workspaces: Memberships;
}) =>
  options.workspaces.membershipsOf({ userId: options.userId }).pipe(
    Effect.orDie,
    Effect.map((ids) => ids.includes(options.workspaceId))
  );

/**
 * Verifies a key and says who it is.
 *
 * The verification is the plugin's: it hashes what arrived, finds the row,
 * refuses a disabled, expired or spent key, and stamps `lastRequest` — which is
 * why the dashboard's last-used column needs no writer of its own and is true
 * of every request rather than of the ones somebody remembered to record.
 */
export const resolveApiKey = Effect.fn("Gateway.resolveApiKey")(function* (
  options: ApiKeyOptions
) {
  const verified = yield* Effect.promise(() =>
    options.auth.api.verifyApiKey({ body: { key: options.key } })
  );

  if (!verified.valid || verified.key === null) {
    const code = verified.error?.code ?? "";
    return SPENT_CODES.has(code)
      ? ({ kind: "spent", reason: KEY_REASONS.spent } satisfies ApiKeyVerdict)
      : refused(KEY_REASONS.rejected);
  }

  // A key with no metadata never said what it was for. Defaulting would be
  // choosing a scope and a board on the issuer's behalf, and the safe default
  // and the useful one are not the same value.
  const metadata = yield* metadataOf(verified.key.metadata);
  if (metadata === null) {
    return refused(KEY_REASONS.unscoped);
  }

  if (!scopeReaches(USER_CEILING, metadata.scope)) {
    return refused(KEY_REASONS.aboveCeiling, true);
  }

  const userId = UserId.make(verified.key.referenceId);
  const member = yield* isMember({
    userId,
    workspaceId: metadata.workspaceId,
    workspaces: options.workspaces,
  });
  if (!member) {
    return refused(KEY_REASONS.notAMember, true);
  }

  return {
    kind: "resolved",
    principal: {
      actor: Actor.cases.human.make({ userId }),
      scope: metadata.scope,
      workspaceId: metadata.workspaceId,
    },
  } satisfies ApiKeyVerdict;
});
