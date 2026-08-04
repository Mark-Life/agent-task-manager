/**
 * The machine credential: a signed, scoped, expiring bearer token the gateway
 * validates from a secret and nothing else.
 *
 * **The trade-off, accepted deliberately.** The first migration has no table
 * for API tokens, and inventing one here would put a schema change on the
 * critical path of an authentication seam. So a token is not a row: it is its
 * own claims plus an HMAC over them, and verifying one is arithmetic on the
 * request thread — no query, no cache, no shared state between the gateway and
 * whatever minted it. What that costs is revocation. A leaked token stays valid
 * until `exp`, and the only blunt instrument is rotating the signing secret,
 * which invalidates every token at once. That is why the lifetimes below are
 * short and why a run's token is bound to its own task: the blast radius of a
 * token nobody can recall is kept small by what it can reach and for how long,
 * rather than by a revocation list that does not exist yet.
 *
 * Adding a `revoked_token` table later is additive and needs no format change —
 * `jti` is already on every token for exactly that day. A denylist read on a
 * short-lived token is a cheap indexed lookup; a *stored* token would instead
 * have made every request a database round trip from the first commit, which is
 * the cost this shape avoids.
 *
 * **One secret, two purposes, two keys.** The signing key is derived from
 * `BETTER_AUTH_SECRET` rather than read from a variable of its own, because a
 * second secret is a second thing to rotate and a second thing to forget in a
 * deployment. Deriving with a fixed label means the key that signs a token and
 * the key Better Auth signs a session cookie with are different keys, so a
 * value forged under one is meaningless under the other.
 *
 * **The token carries its actor.** Not a user id to look up — the whole
 * {@link Actor}, exactly as the audit log stores it. A run's token therefore
 * says which run, which session and which task wrote a row, and the write is
 * attributed without the gateway having to reconstruct it from a token id.
 */

import { createHmac, randomUUID, timingSafeEqual } from "node:crypto";
import { ApiScope, scopeReaches } from "@workspace/api";
import { Actor, WorkspaceId } from "@workspace/domain";
import {
  Clock,
  Config,
  Duration,
  Effect,
  Encoding,
  Redacted,
  Result,
  Schema,
} from "effect";

/**
 * The format marker. It is the first thing checked and the first thing to
 * change: a second token shape ships as `atm2` and both verify side by side for
 * as long as an `atm1` token can still be alive.
 */
const TOKEN_VERSION = "atm1";

/** Separates version, claims and signature. Not a character base64url emits. */
const PART_SEPARATOR = ".";

/** How many parts a well-formed token has. */
const PART_COUNT = 3;

/**
 * Domain separation for the derived signing key. Anything signed under this
 * label is a gateway token and cannot be replayed as any other artifact signed
 * with the same root secret.
 */
const KEY_LABEL = "atm.gateway.token.v1";

/** Milliseconds in a second, for the unix-seconds claims. */
const SECOND_MS = 1000;

/**
 * The root secret. `BETTER_AUTH_SECRET` is the one a deployment already has to
 * set for session cookies to be safe, so reusing it means there is exactly one
 * secret to provision and rotate. No default: a gateway that cannot tell a
 * forged token from a real one has no business starting.
 */
export const tokenSecretConfig = Config.redacted("BETTER_AUTH_SECRET");

/**
 * Why a token was refused. A closed set, because it is a field on the request
 * event and a free-text reason is a field nobody can group by.
 */
export const TOKEN_REJECTIONS = [
  "malformed",
  "unknown_version",
  "bad_signature",
  "unreadable_claims",
  "expired",
  "over_privileged_actor",
] as const;

/** The reason a token did not resolve. */
export const TokenRejection = Schema.Literals(TOKEN_REJECTIONS);
export type TokenRejection = typeof TokenRejection.Type;

/**
 * A bearer token that did not resolve to a principal. Carries only the reason —
 * never the token, never a fragment of it, because this value reaches a log
 * line and a durable event.
 */
export class TokenRejected extends Schema.TaggedErrorClass<TokenRejected>()(
  "TokenRejected",
  { reason: TokenRejection }
) {}

/**
 * What a token asserts. Encoded with the domain's own schemas, so the actor a
 * token carries and the actor an audit row stores are the same value in the
 * same shape, and a claim that no longer decodes is a rejected token rather
 * than a silently different one.
 */
export const TokenClaims = Schema.Struct({
  actor: Actor,
  /** Expiry, unix seconds. Required — a token with no end is a password. */
  exp: Schema.Number,
  /** Issued at, unix seconds. Carried for the audit trail, not enforced. */
  iat: Schema.Number,
  /** This token's identity, so a future denylist has something to name. */
  jti: Schema.String,
  scope: ApiScope,
  workspaceId: WorkspaceId,
});

export interface TokenClaims extends Schema.Schema.Type<typeof TokenClaims> {}

const encodeClaims = Schema.encodeSync(TokenClaims);
const decodeClaims = Schema.decodeUnknownEffect(TokenClaims);

/**
 * The strongest scope an actor of this kind may ever hold.
 *
 * A worker run is the reason this exists: its token is `task-write` bound to
 * one task, and a token claiming `admin` for a run is either a mint-site
 * mistake or a forgery attempt, so it is refused at both ends rather than
 * trusted at either. The orchestrator and the system actor never speak HTTP —
 * they hold the store directly — so a token claiming to be one of them is
 * refused outright.
 */
const ceilingFor = (actor: Actor): ApiScope | null =>
  Actor.match(actor, {
    human: () => "admin" as const,
    manager: () => "task-write" as const,
    orchestrator: () => null,
    system: () => null,
    worker_run: () => "task-write" as const,
  });

/** Whether `scope` is within what an actor of this kind may hold. */
const withinCeiling = (actor: Actor, scope: ApiScope) => {
  const ceiling = ceilingFor(actor);
  return ceiling !== null && scopeReaches(ceiling, scope);
};

/**
 * The signing key, derived from the root secret under {@link KEY_LABEL}. A
 * `Buffer` rather than a string so the raw secret is never re-encoded on the
 * hot path.
 */
const deriveSigningKey = (secret: Redacted.Redacted) =>
  createHmac("sha256", Redacted.value(secret)).update(KEY_LABEL).digest();

/** The signature over one encoded claims segment. */
const signatureOf = (key: Buffer, payload: string) =>
  createHmac("sha256", key).update(payload).digest();

/**
 * Constant-time comparison. A length mismatch is answered before the compare
 * because `timingSafeEqual` throws on unequal lengths, and a thrown error here
 * would be a defect where a refusal is the right answer.
 */
const signatureMatches = (expected: Buffer, actual: Uint8Array) =>
  expected.length === actual.length && timingSafeEqual(expected, actual);

/** What a caller says when it wants a token. */
export interface MintOptions {
  /** Who the token speaks as, stored on every row its bearer writes. */
  readonly actor: Actor;
  /** What it may do. Refused when it exceeds what this kind of actor may hold. */
  readonly scope: ApiScope;
  /** How long it lives. Short, because nothing can recall it early. */
  readonly ttl: Duration.Input;
  /** The one workspace it can see. Never read off a path or a body. */
  readonly workspaceId: WorkspaceId;
}

/**
 * Mints and verifies the bearer tokens this gateway accepts. Built once, over
 * the derived key, so no request pays for the derivation.
 */
export interface TokenSigner {
  /** A fresh token, or a refusal when the scope exceeds the actor's ceiling. */
  readonly mint: (
    options: MintOptions
  ) => Effect.Effect<string, TokenRejected, never>;
  /** The claims a token asserts, once its signature and expiry hold. */
  readonly verify: (
    token: string
  ) => Effect.Effect<TokenClaims, TokenRejected, never>;
}

/** Fails with one refusal reason. */
const reject = (reason: TokenRejection) =>
  Effect.fail(new TokenRejected({ reason }));

/**
 * Builds the signer over a secret already in hand. Separate from
 * {@link makeTokenSigner} so a test can pin the secret without an environment.
 */
export const tokenSignerFrom = (secret: Redacted.Redacted): TokenSigner => {
  const key = deriveSigningKey(secret);

  const mint = Effect.fn("TokenSigner.mint")(function* (options: MintOptions) {
    if (!withinCeiling(options.actor, options.scope)) {
      return yield* reject("over_privileged_actor");
    }

    const now = yield* Clock.currentTimeMillis;
    const issuedAt = Math.floor(now / SECOND_MS);
    const claims = {
      actor: options.actor,
      exp:
        issuedAt +
        Math.floor(Duration.toSeconds(Duration.fromInputUnsafe(options.ttl))),
      iat: issuedAt,
      jti: randomUUID(),
      scope: options.scope,
      workspaceId: options.workspaceId,
    } satisfies TokenClaims;

    const payload = Encoding.encodeBase64Url(
      JSON.stringify(encodeClaims(claims))
    );
    const signature = Encoding.encodeBase64Url(signatureOf(key, payload));
    return [TOKEN_VERSION, payload, signature].join(PART_SEPARATOR);
  });

  const verify = Effect.fn("TokenSigner.verify")(function* (token: string) {
    const parts = token.split(PART_SEPARATOR);
    if (parts.length !== PART_COUNT) {
      return yield* reject("malformed");
    }
    const [version, payload, signature] = parts as [string, string, string];
    if (version !== TOKEN_VERSION) {
      return yield* reject("unknown_version");
    }

    // The signature is checked before anything in the payload is parsed: every
    // byte after this line has been vouched for by the secret, and everything
    // before it is a stranger's.
    const presented = Encoding.decodeBase64Url(signature);
    if (Result.isFailure(presented)) {
      return yield* reject("malformed");
    }
    if (!signatureMatches(signatureOf(key, payload), presented.success)) {
      return yield* reject("bad_signature");
    }

    const json = Encoding.decodeBase64UrlString(payload);
    if (Result.isFailure(json)) {
      return yield* reject("malformed");
    }
    const claims = yield* decodeClaims(
      yield* Effect.try({
        catch: () => new TokenRejected({ reason: "unreadable_claims" }),
        try: () => JSON.parse(json.success) as unknown,
      })
    ).pipe(
      Effect.mapError(() => new TokenRejected({ reason: "unreadable_claims" }))
    );

    const now = yield* Clock.currentTimeMillis;
    if (claims.exp * SECOND_MS <= now) {
      return yield* reject("expired");
    }
    // A validly signed token can still claim more than its actor may ever hold
    // — a mint site with a bug, or a secret that leaked and is being probed.
    // Refusing here means the ceiling holds even if the mint site does not.
    if (!withinCeiling(claims.actor, claims.scope)) {
      return yield* reject("over_privileged_actor");
    }

    return claims;
  });

  return { mint, verify };
};

/** The signer for this process, over the secret in the environment. */
export const makeTokenSigner = Effect.map(tokenSecretConfig, tokenSignerFrom);
