/**
 * What a token promises, and what it refuses.
 *
 * Nothing here needs a database or a network: a token is claims plus an HMAC,
 * so the whole of it is arithmetic and every case below is exact rather than
 * probable. The forgeries are built by hand rather than by mutating a minted
 * token, because a test that only ever sees strings this module produced cannot
 * tell whether the signature is checked at all.
 */

import { describe, expect, test } from "bun:test";
import { createHmac } from "node:crypto";
import {
  Actor,
  AgentSessionId,
  RunId,
  TaskId,
  UserId,
  WorkspaceId,
} from "@workspace/domain";
import { Effect, Encoding, Redacted } from "effect";
import { tokenSignerFrom } from "./tokens";

const SECRET = Redacted.make("test-secret-not-a-real-one");

/** The same derivation the module does, restated so a change to it fails here. */
const signingKey = createHmac("sha256", Redacted.value(SECRET))
  .update("atm.gateway.token.v1")
  .digest();

const workspaceId = WorkspaceId.make("workspace-under-test");

const human = Actor.cases.human.make({ userId: UserId.make("person") });

const workerRun = Actor.cases.worker_run.make({
  runId: RunId.make("0199a000-0000-7000-8000-000000000001"),
  sessionId: AgentSessionId.make("0199a000-0000-7000-8000-000000000002"),
  taskId: TaskId.make("0199a000-0000-7000-8000-000000000003"),
});

const signer = tokenSignerFrom(SECRET);

/** A token in this format, signed correctly, saying whatever the caller wants. */
const forge = (claims: Record<string, unknown>) => {
  const payload = Encoding.encodeBase64Url(JSON.stringify(claims));
  const signature = Encoding.encodeBase64Url(
    createHmac("sha256", signingKey).update(payload).digest()
  );
  return `atm1.${payload}.${signature}`;
};

/** Seconds since the epoch, an hour out. */
const inAnHour = () => Math.floor(Date.now() / 1000) + 3600;

const run = <A, E>(effect: Effect.Effect<A, E>) => Effect.runPromise(effect);

const rejectionOf = <A>(
  effect: Effect.Effect<A, { readonly reason: string }>
) =>
  run(
    effect.pipe(
      Effect.flip,
      Effect.map((error) => error.reason)
    )
  );

describe("a minted token", () => {
  test("verifies back to the claims it was given", async () => {
    const token = await run(
      signer.mint({ actor: human, scope: "admin", ttl: "1 hour", workspaceId })
    );
    const claims = await run(signer.verify(token));

    expect(claims.actor).toEqual(human);
    expect(claims.scope).toBe("admin");
    expect(claims.workspaceId).toBe(workspaceId);
    expect(claims.exp).toBeGreaterThan(claims.iat);
    expect(claims.jti.length).toBeGreaterThan(0);
  });

  test("is refused by a signer holding a different secret", async () => {
    const token = await run(
      signer.mint({ actor: human, scope: "read", ttl: "1 hour", workspaceId })
    );
    const other = tokenSignerFrom(Redacted.make("some-other-secret"));

    expect(await rejectionOf(other.verify(token))).toBe("bad_signature");
  });

  test("carries a run's whole actor, so a write names the run that made it", async () => {
    const token = await run(
      signer.mint({
        actor: workerRun,
        scope: "task-write",
        ttl: "1 hour",
        workspaceId,
      })
    );
    const claims = await run(signer.verify(token));

    expect(claims.actor).toEqual(workerRun);
  });
});

describe("a token that should not exist", () => {
  test("is refused when a run claims the destructive scope", async () => {
    expect(
      await rejectionOf(
        signer.mint({
          actor: workerRun,
          scope: "admin",
          ttl: "1 hour",
          workspaceId,
        })
      )
    ).toBe("over_privileged_actor");
  });

  test("is refused for an actor that never speaks HTTP", async () => {
    expect(
      await rejectionOf(
        signer.mint({
          actor: Actor.cases.orchestrator.make({ loopInstance: "loop" }),
          scope: "read",
          ttl: "1 hour",
          workspaceId,
        })
      )
    ).toBe("over_privileged_actor");
  });

  test("is refused at verify even when correctly signed", async () => {
    const forged = forge({
      actor: workerRun,
      exp: inAnHour(),
      iat: Math.floor(Date.now() / 1000),
      jti: "forged",
      scope: "admin",
      workspaceId,
    });

    expect(await rejectionOf(signer.verify(forged))).toBe(
      "over_privileged_actor"
    );
  });
});

describe("a token that does not verify", () => {
  test("names a tampered payload as a bad signature", async () => {
    const token = await run(
      signer.mint({ actor: human, scope: "read", ttl: "1 hour", workspaceId })
    );
    const [version, , signature] = token.split(".");
    const swapped = Encoding.encodeBase64Url(
      JSON.stringify({
        actor: human,
        exp: inAnHour(),
        iat: 0,
        jti: "swapped",
        scope: "admin",
        workspaceId,
      })
    );

    expect(
      await rejectionOf(signer.verify(`${version}.${swapped}.${signature}`))
    ).toBe("bad_signature");
  });

  test("names an unknown format rather than guessing at it", async () => {
    const token = await run(
      signer.mint({ actor: human, scope: "read", ttl: "1 hour", workspaceId })
    );

    expect(await rejectionOf(signer.verify(`atm9${token.slice(4)}`))).toBe(
      "unknown_version"
    );
  });

  test("names anything shapeless as malformed", async () => {
    expect(await rejectionOf(signer.verify(""))).toBe("malformed");
    expect(await rejectionOf(signer.verify("not-a-token"))).toBe("malformed");
    expect(await rejectionOf(signer.verify("a.b.c.d"))).toBe("malformed");
  });

  test("refuses claims that are signed but no longer decode", async () => {
    const forged = forge({ scope: "admin", workspaceId });

    expect(await rejectionOf(signer.verify(forged))).toBe("unreadable_claims");
  });

  test("refuses one whose expiry has passed", async () => {
    const expired = await run(
      signer.mint({
        actor: human,
        scope: "read",
        ttl: "0 seconds",
        workspaceId,
      })
    );

    expect(await rejectionOf(signer.verify(expired))).toBe("expired");
  });
});
