/**
 * The claim the credential makes: it outlives the run that holds it.
 *
 * The bug this file exists to keep fixed had no failing component in it.
 * Minting worked, signing worked, verifying worked, and the run worked — the
 * lifetime was simply shorter than the work, so a token minted at dispatch was
 * refused by the same gateway that issued it some hours later, and every board
 * tool went with it at once. Nothing was broken; the two numbers disagreed.
 *
 * So the test is a clock rather than a mock. A real signer mints a real token
 * for a run with a real deadline, the clock is moved forward past the lifetime
 * the old default gave it, and the same signer is asked whether it would still
 * accept the token. `TestClock` is what makes that exact, because both `mint`
 * and `verify` read the time through `Clock` — the whole of the expiry is
 * arithmetic on a number this test controls, so "a run that lasted twelve
 * hours" is an assertion rather than a twelve-hour test.
 *
 * The old lifetime is asserted alongside the new one on purpose. A test that
 * only showed the fixed token surviving would pass just as well if the expiry
 * check were removed altogether; showing that the same instant refuses the
 * fifteen-minute token and accepts the derived one is what makes it a proof of
 * the fix rather than of the clock.
 */

import { describe, expect, test } from "bun:test";
import { AgentSessionId, RunId, TaskId, WorkspaceId } from "@workspace/domain";
import {
  type AgentBinding,
  DEFAULT_AGENT_TOKEN_TTL_MS,
  mintAgentToken,
  tokenSignerFrom,
} from "@workspace/token";
import { Effect, Redacted } from "effect";
import { TestClock } from "effect/testing";
import { tokenTtlFor } from "./agent-token";

const signer = tokenSignerFrom(Redacted.make("test-secret-not-a-real-one"));

const workspaceId = WorkspaceId.make("workspace-under-test");

/** A worker's binding: the one a long run holds and the one that expired. */
const binding: AgentBinding = {
  kind: "worker_run",
  runId: RunId.make("0199a000-0000-7000-8000-000000000001"),
  sessionId: AgentSessionId.make("0199a000-0000-7000-8000-000000000002"),
  taskId: TaskId.make("0199a000-0000-7000-8000-000000000003"),
};

/** The run cap this loop ships with: a day, because a worker run is a day's work. */
const RUN_TIMEOUT_MS = 86_400_000;

/** The manager's cap, which is a turn with a person waiting on it. */
const CHAT_TIMEOUT_MS = 1_800_000;

const MINUTE_MS = 60_000;
const HOUR_MS = 3_600_000;

const mintFor = (ttlMs: number) =>
  mintAgentToken({ binding, signer, ttlMs, workspaceId }).pipe(
    Effect.map(Redacted.value)
  );

/**
 * Whether the gateway would still take this token: `true`, or the reason it
 * refused. The reason rather than a bare `false`, because "expired" and
 * "bad_signature" failing the same assertion is how a broken signer passes as
 * a correct expiry.
 */
const accepts = (token: string) =>
  signer.verify(token).pipe(
    Effect.as(true),
    Effect.catchTag("TokenRejected", (rejected) =>
      Effect.succeed(rejected.reason)
    )
  );

/** One scripted run on a clock this test owns. */
const onTheClock = <A, E>(program: Effect.Effect<A, E, never>) =>
  Effect.runPromise(program.pipe(Effect.provide(TestClock.layer())));

describe("tokenTtlFor", () => {
  test("gives a run's credential the run's own deadline, plus room to land", () => {
    const ttl = tokenTtlFor({ configured: null, timeoutMs: RUN_TIMEOUT_MS });
    expect(ttl).toBeGreaterThan(RUN_TIMEOUT_MS);
  });

  test("outlives every turn the loop is willing to run", () => {
    for (const timeoutMs of [CHAT_TIMEOUT_MS, RUN_TIMEOUT_MS]) {
      expect(tokenTtlFor({ configured: null, timeoutMs })).toBeGreaterThan(
        timeoutMs
      );
    }
  });

  test("lets a deployment that wants a shorter blast radius say so", () => {
    expect(tokenTtlFor({ configured: 60_000, timeoutMs: RUN_TIMEOUT_MS })).toBe(
      60_000
    );
  });
});

describe("a run that outlasts the old token lifetime", () => {
  test("still holds a credential the gateway accepts, at the last turn of a day-long run", async () => {
    const verdicts = await onTheClock(
      Effect.gen(function* () {
        const token = yield* mintFor(
          tokenTtlFor({ configured: null, timeoutMs: RUN_TIMEOUT_MS })
        );

        // The instant the run used to lose the board: one minute past the
        // fixed fifteen the credential used to be minted with.
        yield* TestClock.adjust(DEFAULT_AGENT_TOKEN_TTL_MS + MINUTE_MS);
        const pastOldExpiry = yield* accepts(token);

        // Most of the way through the run's own cap — a worker that has been
        // working through the night and is about to write up what it did.
        yield* TestClock.adjust(RUN_TIMEOUT_MS - HOUR_MS);
        const nearTheDeadline = yield* accepts(token);

        return { nearTheDeadline, pastOldExpiry };
      })
    );

    expect(verdicts.pastOldExpiry).toBe(true);
    expect(verdicts.nearTheDeadline).toBe(true);
  });

  test("would have lost it at the same instant under the old fixed lifetime", async () => {
    const verdict = await onTheClock(
      Effect.gen(function* () {
        const token = yield* mintFor(DEFAULT_AGENT_TOKEN_TTL_MS);
        yield* TestClock.adjust(DEFAULT_AGENT_TOKEN_TTL_MS + MINUTE_MS);
        return yield* accepts(token);
      })
    );

    // The bug, reproduced: the gateway refusing its own token, which is what
    // every `mcp__atm__*` tool reported as `Unauthorized: token_expired`.
    expect(verdict).toBe("expired");
  });

  test("posts its comment, registers its artifact and moves its card on one credential", async () => {
    // Three tools, three moments, one token — the sequence the reporting run
    // could not finish. Board calls are HTTP requests carrying this bearer, so
    // what "the tool still works" means at this layer is exactly this.
    const verdicts = await onTheClock(
      Effect.gen(function* () {
        const token = yield* mintFor(
          tokenTtlFor({ configured: null, timeoutMs: RUN_TIMEOUT_MS })
        );
        const seen: boolean[] = [];
        for (const _ of [
          "artifacts written", // hours in
          "comment posted", // the final turn
          "status set", // after it
        ]) {
          yield* TestClock.adjust(8 * HOUR_MS);
          seen.push((yield* accepts(token)) === true);
        }
        return seen;
      })
    );

    expect(verdicts).toEqual([true, true, true]);
  });

  test("expires once the run it belongs to could no longer be alive", async () => {
    // The lifetime is derived from the deadline, so it ends near it. A token
    // that outlived its run by a day would be a credential nobody can recall,
    // sitting on a mount, long after there is any work for it to do.
    const verdict = await onTheClock(
      Effect.gen(function* () {
        const token = yield* mintFor(
          tokenTtlFor({ configured: null, timeoutMs: RUN_TIMEOUT_MS })
        );
        yield* TestClock.adjust(RUN_TIMEOUT_MS + HOUR_MS);
        return yield* accepts(token);
      })
    );

    expect(verdict).toBe("expired");
  });
});
