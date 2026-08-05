import { describe, expect, it } from "bun:test";
import { Effect, Redacted } from "effect";
import {
  SEALED_KEY_VERSION,
  type SealedSecret,
  secretSealerFrom,
} from "./secrets";

/** A fixed secret, so every assertion here is about the construction and not about randomness. */
const sealer = secretSealerFrom(Redacted.make("test-root-secret"));

/** A second root, for the value one sealer must not be able to open from the other. */
const other = secretSealerFrom(Redacted.make("a-different-root-secret"));

const run = <A, E>(effect: Effect.Effect<A, E>) => Effect.runSync(effect);

const roundTrip = (plaintext: string) =>
  run(
    Effect.flatMap(sealer.seal(Redacted.make(plaintext)), (sealed) =>
      Effect.map(sealer.open(sealed), Redacted.value)
    )
  );

describe("sealing a secret", () => {
  it("gives the value back", () => {
    expect(roundTrip("DATABASE_URL=postgres://x\nAPI_KEY=abc\n")).toBe(
      "DATABASE_URL=postgres://x\nAPI_KEY=abc\n"
    );
  });

  it("round-trips an empty file, which is a file an operator can save", () => {
    expect(roundTrip("")).toBe("");
  });

  it("round-trips multi-byte text without losing a byte", () => {
    expect(roundTrip("GREETING=привет 🌍\n")).toBe("GREETING=привет 🌍\n");
  });

  it("records the derivation on the value", () => {
    const sealed = run(sealer.seal(Redacted.make("x")));
    expect(sealed.keyVersion).toBe(SEALED_KEY_VERSION);
  });

  it("never holds the plaintext", () => {
    const sealed = run(sealer.seal(Redacted.make("SUPER_SECRET_VALUE")));
    expect(Buffer.from(sealed.content).toString("utf8")).not.toContain(
      "SUPER_SECRET_VALUE"
    );
  });

  it("uses a fresh nonce, so the same text seals to different bytes", () => {
    const once = run(sealer.seal(Redacted.make("same")));
    const twice = run(sealer.seal(Redacted.make("same")));
    expect(Buffer.from(once.content).equals(Buffer.from(twice.content))).toBe(
      false
    );
  });
});

describe("opening a sealed value", () => {
  const failureOf = (sealed: SealedSecret) =>
    run(Effect.flip(sealer.open(sealed)));

  it("refuses a derivation this build does not have", () => {
    const sealed = run(sealer.seal(Redacted.make("x")));
    expect(
      failureOf({ ...sealed, keyVersion: SEALED_KEY_VERSION + 1 }).reason
    ).toBe("unknown_key_version");
  });

  it("refuses a value too short to hold a nonce and a tag", () => {
    expect(
      failureOf({ content: new Uint8Array(8), keyVersion: SEALED_KEY_VERSION })
        .reason
    ).toBe("malformed");
  });

  it("refuses a value whose bytes were edited", () => {
    const sealed = run(sealer.seal(Redacted.make("DATABASE_URL=postgres://x")));
    const tampered = Uint8Array.from(sealed.content);
    // The last byte is inside the tag, which is what makes this a forgery
    // rather than a decode that happens to produce different text.
    const last = tampered.length - 1;
    tampered.set([((tampered.at(last) ?? 0) + 1) % 256], last);
    expect(failureOf({ ...sealed, content: tampered }).reason).toBe(
      "not_authentic"
    );
  });

  it("refuses a value sealed under a different root secret", () => {
    const sealed = run(other.seal(Redacted.make("x")));
    expect(failureOf(sealed).reason).toBe("not_authentic");
  });

  it("carries no plaintext on the failure", () => {
    const sealed = run(sealer.seal(Redacted.make("x")));
    const failure = failureOf({ ...sealed, keyVersion: 99 });
    expect(Object.keys(failure)).not.toContain("content");
  });
});
