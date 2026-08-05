/**
 * Sealing a secret so Postgres never holds it in the clear, and opening it
 * again on the one path that needs the value back.
 *
 * **Encrypted, not hashed, because the value has to come out.** A project's
 * environment file is written into a run's checkout: the system is required to
 * be able to read it back, which rules out every one-way construction. So
 * AES-256-GCM, authenticated, and what a row stores is the nonce, the
 * ciphertext and the tag concatenated — one column, one value, no framing of
 * our own to get wrong.
 *
 * That is what answers the question a `text` column raises. The statement the
 * driver sends carries ciphertext, so a statement log, a slow-query log, a
 * replica and a `pg_dump` all leak nothing. Plaintext is never a query
 * parameter and never a value the database has seen.
 *
 * **One root secret, one more derived key.** The key comes from
 * `BETTER_AUTH_SECRET` under a label of its own, exactly as the token signer
 * derives its signing key under a label of its own — a second secret is a
 * second thing to provision and a second thing to forget. Two labels means the
 * key that seals a file, the key that signs a bearer token and the key Better
 * Auth signs a session cookie with are three different keys, so a value forged
 * or leaked under one is meaningless under the others.
 *
 * **The trust boundary, stated plainly.** Whoever holds the loop's environment
 * holds `BETTER_AUTH_SECRET` and can therefore open every project's files. On a
 * single-operator host with secrets in one file read by one service account,
 * that is the boundary the GitHub token and the Executor key already sit
 * behind. A per-project wrapped key would only start to mean something with a
 * second operator, and by then the sandboxes are somebody else's service.
 *
 * **{@link SEALED_KEY_VERSION} exists from the first row, with one key.** The
 * version names the *derivation*, not the secret: a later change of algorithm
 * or label ships as version 2, both open side by side while a re-encryption
 * pass runs, and the pass can tell a done row from a pending one by reading the
 * column. Without the version that migration has nowhere to record its own
 * progress, and the day it is needed is the worst day to be adding a column.
 *
 * Rotating `BETTER_AUTH_SECRET` itself is a different operation and this file
 * does not pretend otherwise: every sealed value has to be opened under the old
 * secret and re-sealed under the new one. {@link secretSealerFrom} takes the
 * secret as an argument for exactly that — a script can hold two sealers at
 * once — and nothing here silently falls back to a second key.
 */

import {
  createCipheriv,
  createDecipheriv,
  createHmac,
  randomBytes,
} from "node:crypto";
import { Config, Effect, Redacted, Schema } from "effect";

/**
 * Domain separation for the derived sealing key. Anything sealed under this
 * label is a stored secret of ours and cannot be opened by, or confused with,
 * anything else derived from the same root.
 */
const KEY_LABEL = "atm.project.secret.v1";

/**
 * The derivation every row written today records. Read back off the row and
 * matched before a key is chosen, so a value written under a derivation this
 * build does not have is refused rather than opened with the wrong key and
 * reported as corrupt.
 */
export const SEALED_KEY_VERSION = 1;

/** AES-256 in Galois/Counter mode: confidentiality and integrity in one pass. */
const ALGORITHM = "aes-256-gcm";

/**
 * Nonce length. Twelve bytes is GCM's native size — the one length that needs
 * no internal re-derivation — and it is fresh per seal, from the system CSPRNG.
 */
const IV_BYTES = 12;

/** The authentication tag GCM produces, at its full length. */
const TAG_BYTES = 16;

/** Why a sealed value did not open. Closed, because it reaches a log line. */
export const SECRET_FAILURES = [
  "unknown_key_version",
  "malformed",
  "not_authentic",
] as const;

/** What went wrong opening a sealed value. */
export const SecretFailure = Schema.Literals(SECRET_FAILURES);
export type SecretFailure = typeof SecretFailure.Type;

/**
 * A stored secret that could not be read back. Carries the reason and the
 * version it claimed, and never a byte of the value — this reaches a log line
 * and a failed request.
 *
 * `not_authentic` is the interesting one: GCM verifies the tag before it hands
 * back a plaintext, so a row edited in the database, a truncated column and a
 * value sealed under a different root secret all land here rather than
 * producing text that decodes to nonsense.
 */
export class SecretUnreadable extends Schema.TaggedErrorClass<SecretUnreadable>()(
  "Token.SecretUnreadable",
  { keyVersion: Schema.Number, reason: SecretFailure }
) {}

/** One sealed value, exactly as a row holds it. */
export interface SealedSecret {
  /** `iv ‖ ciphertext ‖ tag`. One column, so a row cannot hold half of a value. */
  readonly content: Uint8Array;
  /** Which derivation produced the key. See {@link SEALED_KEY_VERSION}. */
  readonly keyVersion: number;
}

/**
 * Seals and opens the secrets this workspace stores. Built once over the
 * derived key, so no request pays for the derivation.
 */
export interface SecretSealer {
  /**
   * Reads one back. Redacted, because the value's whole point is that it must
   * not appear in a log line, an error or a span attribute on the way to the
   * one place that unwraps it.
   */
  readonly open: (
    sealed: SealedSecret
  ) => Effect.Effect<Redacted.Redacted<string>, SecretUnreadable>;
  /** Seals one. An effect because the nonce is fresh randomness, not a pure function of the input. */
  readonly seal: (
    plaintext: Redacted.Redacted<string>
  ) => Effect.Effect<SealedSecret>;
}

/**
 * The sealing key, derived from the root secret under {@link KEY_LABEL}.
 * HMAC-SHA256 gives exactly the 32 bytes AES-256 takes, and it is the same
 * construction the token signer uses — one derivation to review rather than
 * two.
 */
const deriveSealingKey = (secret: Redacted.Redacted) =>
  createHmac("sha256", Redacted.value(secret)).update(KEY_LABEL).digest();

/** Fails with one reason, at the version the row claimed. */
const unreadable = (reason: SecretFailure, keyVersion: number) =>
  Effect.fail(new SecretUnreadable({ keyVersion, reason }));

/**
 * Builds the sealer over a secret already in hand. Separate from
 * {@link makeSecretSealer} so a test can pin the secret without an environment,
 * and so a re-encryption script can hold the old secret's sealer and the new
 * one's at the same time.
 */
export const secretSealerFrom = (secret: Redacted.Redacted): SecretSealer => {
  const key = deriveSealingKey(secret);

  const seal = (plaintext: Redacted.Redacted<string>) =>
    Effect.sync(() => {
      const iv = randomBytes(IV_BYTES);
      const cipher = createCipheriv(ALGORITHM, key, iv);
      const ciphertext = Buffer.concat([
        cipher.update(Redacted.value(plaintext), "utf8"),
        cipher.final(),
      ]);
      return {
        content: Uint8Array.from(
          Buffer.concat([iv, ciphertext, cipher.getAuthTag()])
        ),
        keyVersion: SEALED_KEY_VERSION,
      } satisfies SealedSecret;
    });

  const open = (sealed: SealedSecret) =>
    Effect.gen(function* () {
      if (sealed.keyVersion !== SEALED_KEY_VERSION) {
        return yield* unreadable("unknown_key_version", sealed.keyVersion);
      }
      // A value shorter than a nonce and a tag has no ciphertext in it at all,
      // and slicing it would hand GCM two overlapping buffers rather than
      // failing on the length that is actually wrong.
      if (sealed.content.length < IV_BYTES + TAG_BYTES) {
        return yield* unreadable("malformed", sealed.keyVersion);
      }
      const bytes = Buffer.from(
        sealed.content.buffer,
        sealed.content.byteOffset,
        sealed.content.byteLength
      );
      const iv = bytes.subarray(0, IV_BYTES);
      const ciphertext = bytes.subarray(IV_BYTES, bytes.length - TAG_BYTES);
      const tag = bytes.subarray(bytes.length - TAG_BYTES);

      return yield* Effect.try({
        // The tag failed, which is a value that was edited, truncated, or
        // sealed under a different root secret. Which of the three it was is
        // not knowable from here and the answer is the same either way.
        catch: () =>
          new SecretUnreadable({
            keyVersion: sealed.keyVersion,
            reason: "not_authentic",
          }),
        try: () => {
          const decipher = createDecipheriv(ALGORITHM, key, iv);
          decipher.setAuthTag(tag);
          return Redacted.make(
            Buffer.concat([
              decipher.update(ciphertext),
              decipher.final(),
            ]).toString("utf8")
          );
        },
      });
    });

  return { open, seal };
};

/**
 * The root secret. The same one the token signer reads, so a deployment
 * provisions one value and rotates one value.
 */
export const secretSealerConfig = Config.redacted("BETTER_AUTH_SECRET");

/** The sealer for this process, over the secret in the environment. */
export const makeSecretSealer = Effect.map(
  secretSealerConfig,
  secretSealerFrom
);
