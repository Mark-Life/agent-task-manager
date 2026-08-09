/**
 * The claim the credential makes: a run holds a live one for as long as it
 * runs, however long that is.
 *
 * The bug this file exists to keep fixed had no failing component in it.
 * Minting worked, signing worked, verifying worked, and the run worked — the
 * lifetime was simply shorter than the work, so a token minted at dispatch was
 * refused by the same gateway that issued it some hours later, and every board
 * tool went with it at once. Nothing was broken; the two numbers disagreed.
 *
 * The fix is to stop having two numbers. The credential is a file on the run
 * mount that is rewritten while the run works, so the question "does the token
 * outlive the run" has no answer to get wrong — what is asserted below is that
 * at the far end of a run twelve hours long, the file holds a token this signer
 * still accepts, and that it is not the one the run started with.
 *
 * So the test is a clock rather than a mock. A real signer mints real tokens
 * onto a real directory, and `TestClock` is what makes "twelve hours later"
 * exact: both `mint` and `verify` read the time through `Clock`, and the whole
 * of the expiry is arithmetic on a number this test controls.
 *
 * The old shape is asserted alongside the new one on purpose. A test that only
 * showed the rolled credential surviving would pass just as well if the expiry
 * check were removed altogether; showing that the same instant refuses a single
 * minted token and accepts the rolled one is what makes it a proof of the fix
 * rather than of the clock.
 */

import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { BunFileSystem } from "@effect/platform-bun";
import { agentMcpBundlePathOf, agentTokenPathOf } from "@workspace/agent-tools";
import { AgentSessionId, RunId, TaskId, WorkspaceId } from "@workspace/domain";
import {
  type AgentBinding,
  DEFAULT_AGENT_TOKEN_TTL_MS,
  mintAgentToken,
  tokenSignerFrom,
} from "@workspace/token";
import { Effect, Redacted, Result, type Scope } from "effect";
import { FileSystem } from "effect/FileSystem";
import { TestClock } from "effect/testing";
import {
  AgentBundleMissing,
  agentBundlePath,
  refreshPeriodOf,
  scopedRollingToken,
} from "./agent-token";

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

const MINUTE_MS = 60_000;
const HOUR_MS = 3_600_000;

/** How many times the refresh fiber is given a chance to land its write. */
const SETTLE_YIELDS = 200;

const directories: string[] = [];

afterEach(() => {
  for (const directory of directories.splice(0)) {
    rmSync(directory, { force: true, recursive: true });
  }
});

/** A run directory of this test's own, cleaned up after it. */
const runDir = () => {
  const dir = mkdtempSync(join(tmpdir(), "atm-rolling-token-"));
  directories.push(dir);
  return dir;
};

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

/** One scripted run on a clock and a scope this test owns. */
const onTheClock = <A, E>(
  program: Effect.Effect<A, E, FileSystem | Scope.Scope>
) =>
  Effect.runPromise(
    Effect.scoped(program).pipe(
      Effect.provide(BunFileSystem.layer),
      Effect.provide(TestClock.layer())
    )
  );

/**
 * The credential on the mount, once the refresh fiber woken by the clock has
 * finished writing it.
 *
 * The fiber is woken by `TestClock.adjust` but lands its write on the event
 * loop, so the read is retried across yields rather than taken immediately.
 * Bounded, so a refresh that never happens fails the assertion below instead of
 * hanging the suite.
 */
const rolledPast = (path: string, previous: string) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem;
    for (let attempt = 0; attempt < SETTLE_YIELDS; attempt += 1) {
      const current = yield* fs.readFileString(path);
      if (current !== previous) {
        return current;
      }
      yield* Effect.yieldNow;
    }
    return yield* fs.readFileString(path);
  });

/** The rolling credential for one run, in a directory of this test's own. */
const rollingIn = (dir: string, ttlMs: number) =>
  scopedRollingToken({
    binding,
    path: agentTokenPathOf(dir),
    signer,
    ttlMs,
    workspaceId,
  });

describe("refreshPeriodOf", () => {
  test("replaces the credential several times inside its own lifetime", () => {
    const period = refreshPeriodOf(DEFAULT_AGENT_TOKEN_TTL_MS);
    expect(period).toBeLessThan(DEFAULT_AGENT_TOKEN_TTL_MS);
    expect(DEFAULT_AGENT_TOKEN_TTL_MS / period).toBeGreaterThanOrEqual(3);
  });

  test("does not spin when a deployment asks for a very short lifetime", () => {
    expect(refreshPeriodOf(300)).toBeGreaterThanOrEqual(10_000);
  });
});

describe("a run that outlasts one token lifetime", () => {
  test("still holds a credential the gateway accepts, twelve hours in", async () => {
    const dir = runDir();
    const verdicts = await onTheClock(
      Effect.gen(function* () {
        const fs = yield* FileSystem;
        const path = yield* rollingIn(dir, DEFAULT_AGENT_TOKEN_TTL_MS);
        const first = yield* fs.readFileString(path);
        const atDispatch = yield* accepts(first);

        // Twelve hours of work, in the steps the refresh fiber actually wakes
        // on. The last one is the turn that writes up what it did — the call
        // the reporting run could not make.
        const period = refreshPeriodOf(DEFAULT_AGENT_TOKEN_TTL_MS);
        let held = first;
        const seen: (string | boolean)[] = [];
        for (let elapsed = 0; elapsed < 12 * HOUR_MS; elapsed += period) {
          yield* TestClock.adjust(period);
          held = yield* rolledPast(path, held);
          seen.push(yield* accepts(held));
        }

        return { atDispatch, changed: held !== first, seen };
      })
    );

    expect(verdicts.atDispatch).toBe(true);
    expect(verdicts.changed).toBe(true);
    expect(new Set(verdicts.seen)).toEqual(new Set([true]));
  });

  test("would have been refused at the same instant on a single minted token", async () => {
    const verdict = await onTheClock(
      Effect.gen(function* () {
        const token = yield* mintAgentToken({
          binding,
          signer,
          ttlMs: DEFAULT_AGENT_TOKEN_TTL_MS,
          workspaceId,
        }).pipe(Effect.map(Redacted.value));
        yield* TestClock.adjust(DEFAULT_AGENT_TOKEN_TTL_MS + MINUTE_MS);
        return yield* accepts(token);
      })
    );

    // The bug, reproduced: the gateway refusing its own token, which is what
    // every `mcp__atm__*` tool reported as `Unauthorized: token_expired`.
    expect(verdict).toBe("expired");
  });

  test("writes nothing a stopped run could still use", async () => {
    const dir = runDir();
    const path = agentTokenPathOf(dir);

    // The scope closes with the run, and the credential goes with it: deleting
    // the file is the only way this token shape can be recalled early, so a
    // file left behind is a live credential nobody is watching.
    const present = await onTheClock(
      Effect.gen(function* () {
        const fs = yield* FileSystem;
        yield* Effect.scoped(
          rollingIn(dir, DEFAULT_AGENT_TOKEN_TTL_MS).pipe(
            Effect.andThen(fs.exists(path))
          )
        );
        return yield* fs.exists(path);
      })
    );

    expect(present).toBe(false);
  });

  test("keeps rolling for the whole of the longest run the loop allows", async () => {
    const dir = runDir();
    const verdict = await onTheClock(
      Effect.gen(function* () {
        const fs = yield* FileSystem;
        const path = yield* rollingIn(dir, DEFAULT_AGENT_TOKEN_TTL_MS);
        let held = yield* fs.readFileString(path);
        const period = refreshPeriodOf(DEFAULT_AGENT_TOKEN_TTL_MS);
        for (let elapsed = 0; elapsed < RUN_TIMEOUT_MS; elapsed += period) {
          yield* TestClock.adjust(period);
          held = yield* rolledPast(path, held);
        }
        return yield* accepts(held);
      })
    );

    expect(verdict).toBe(true);
  });
});

/**
 * The other half of what a turn's board access is made of, and the half that
 * used to cost 1.7 MB of disk per run.
 *
 * The bundle is one file on the host now, named for the mount set rather than
 * copied onto the run mount. What is worth asserting is what changed with it:
 * that the answer is the host's own path and nothing under the run directory,
 * so a reader who reintroduces the copy fails a test rather than filling a
 * disk, and that a host which never bundled still fails the run by name.
 */
describe("the board tools bundle", () => {
  const onDisk = <A, E>(program: Effect.Effect<A, E, FileSystem>) =>
    Effect.runPromise(
      Effect.result(program).pipe(Effect.provide(BunFileSystem.layer))
    );

  test("is the one file on the host, not a copy in the run directory", async () => {
    const dataRoot = runDir();
    const result = await onDisk(
      Effect.gen(function* () {
        const fs = yield* FileSystem;
        const path = agentMcpBundlePathOf(dataRoot);
        yield* fs.makeDirectory(dirname(path), { recursive: true });
        yield* fs.writeFileString(path, "// the bundle\n");
        return yield* agentBundlePath({ dataRoot });
      })
    );

    expect(result).toEqual(Result.succeed(agentMcpBundlePathOf(dataRoot)));
  });

  test("fails the run by name when the host never bundled it", async () => {
    const dataRoot = runDir();
    const result = await onDisk(agentBundlePath({ dataRoot }));

    // Its own failure, not a warning: an agent with no way to reach the board
    // answers anyway, and what it answers is an account of tasks it never filed.
    expect(Result.isFailure(result)).toBe(true);
    expect(result).toEqual(
      Result.fail(
        new AgentBundleMissing({ path: agentMcpBundlePathOf(dataRoot) })
      )
    );
  });
});
