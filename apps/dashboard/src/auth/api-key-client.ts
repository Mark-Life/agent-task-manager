import { apiKeyClient } from "@better-auth/api-key/client";
import type { ApiKeyMetadata, ApiScope } from "@workspace/api";
import { createAuthClient } from "better-auth/react";
import { authClientOptions } from "@/auth/client";

/**
 * The API key plugin's client, kept behind three functions of our own.
 *
 * Keys are managed through the auth library rather than through the board's
 * HTTP contract, for the same reason signing in is: they are how a caller
 * obtains a credential, not something done with one. The plugin already refuses
 * to list or revoke a key belonging to anybody but the session holder, so
 * putting key management in `packages/api` would mean reimplementing that check
 * against a table the auth library owns.
 *
 * **Why a second client rather than another plugin on the first.** The plugin's
 * client type carries `$InferServerPlugin`, which drags the whole server-side
 * endpoint definition — and with it the zod schemas of every one of its routes
 * — into whatever it is attached to. Added to `./client`, that made the shared
 * `authClient`'s inferred type unnameable, so declaration emit failed on a
 * private zod internal. Confining it here costs one extra client object and
 * buys a boundary: the type below is spelled out, so nothing past this file
 * depends on the library's inference at all.
 *
 * The client is not exported for the same reason. What leaves this module is
 * three functions with written-out signatures.
 */
const keyClient = createAuthClient({
  ...authClientOptions,
  plugins: [apiKeyClient()],
});

/** A key as the dashboard reads it: what it is, what it may do, whether it is used. */
export interface IssuedKey {
  readonly createdAt: Date;
  readonly expiresAt: Date | null;
  readonly id: string;
  /** When it last authenticated a request. Null means it never has. */
  readonly lastRequest: Date | null;
  readonly name: string | null;
  /** Null for a key issued by something that did not record one. */
  readonly scope: ApiScope | null;
  /** The plain-text opening of the key, which is all that is kept of it. */
  readonly start: string | null;
}

/** What issuing a key needs. Everything else about it is the plugin's business. */
export interface KeyRequest {
  /** Days until it stops working, or null for a key that does not expire. */
  readonly expiresInDays: number | null;
  readonly name: string;
  readonly scope: ApiScope;
  readonly workspaceId: string;
}

const SECONDS_PER_DAY = 86_400;

/** The scope a key says it holds, or null when it does not say one we know. */
const scopeOf = (metadata: unknown): ApiScope | null => {
  if (typeof metadata !== "object" || metadata === null) {
    return null;
  }
  const { scope } = metadata as Partial<ApiKeyMetadata>;
  return scope === "read" || scope === "task-write" || scope === "admin"
    ? scope
    : null;
};

const dateOf = (value: Date | string | null | undefined) =>
  value === null || value === undefined ? null : new Date(value);

/** Whatever the library said went wrong, as an error a query can surface. */
const failed = (message: string | undefined, fallback: string) =>
  new Error(message ?? fallback);

/**
 * Every key this person holds, newest first.
 *
 * The secret is not among them and cannot be: the library stores a hash, so
 * what comes back is the name, the opening characters and the usage — which is
 * exactly why the value is shown once at creation and never again.
 */
export const listKeys = async (): Promise<readonly IssuedKey[]> => {
  const result = await keyClient.apiKey.list();
  if (result.error !== null) {
    throw failed(result.error.message, "Keys did not load");
  }
  return (result.data?.apiKeys ?? [])
    .map(
      (row): IssuedKey => ({
        createdAt: new Date(row.createdAt),
        expiresAt: dateOf(row.expiresAt),
        id: row.id,
        lastRequest: dateOf(row.lastRequest),
        name: row.name,
        scope: scopeOf(row.metadata),
        start: row.start,
      })
    )
    .sort(
      (left, right) => right.createdAt.getTime() - left.createdAt.getTime()
    );
};

/**
 * Issue a key, and return the one copy of it there will ever be.
 *
 * The scope and the workspace go into the key's metadata, which is what the
 * gateway reads to decide what the key may do and which board it speaks for.
 * Both are checked there against the issuer rather than believed, so what is
 * written here is a statement of intent and not a grant.
 */
export const createKey = async (request: KeyRequest): Promise<string> => {
  const metadata: ApiKeyMetadata = {
    scope: request.scope,
    workspaceId: request.workspaceId as ApiKeyMetadata["workspaceId"],
  };
  const result = await keyClient.apiKey.create({
    expiresIn:
      request.expiresInDays === null
        ? null
        : request.expiresInDays * SECONDS_PER_DAY,
    metadata,
    name: request.name,
  });
  if (result.error !== null) {
    throw failed(result.error.message, "The key was not created");
  }
  if (result.data === null) {
    throw failed(undefined, "The key was not created");
  }
  return result.data.key;
};

/**
 * Revoke a key. The row goes, so the next request carrying it finds nothing and
 * is refused — there is no grace period and nothing to un-revoke.
 */
export const revokeKey = async (keyId: string): Promise<void> => {
  const result = await keyClient.apiKey.delete({ keyId });
  if (result.error !== null) {
    throw failed(result.error.message, "The key was not revoked");
  }
};
