/**
 * Reading rows another process is still in the middle of writing.
 *
 * Everything this bot says about a run is read back off the database after a
 * notification woke it, and the notification is not the last write of that run.
 * A run's terminal event is appended by the ingest *while the container is
 * shutting down*; the run row's outcome, the task's move into review and the
 * manager's answer are written after it. So a reader that answers the instant
 * it is woken sees a finished run as still running, a reviewable task as in
 * progress, and a conversation with no answer in it.
 *
 * The fix is one shape, used by everything that reads after a run event: read,
 * and if what came back is still mid-close, wait a moment and read again, up to
 * a bounded window. It is not a retry ladder around a failure — every read here
 * succeeds — it is waiting for a writer that has already been told to write.
 *
 * The window is a ceiling on how long a reader is willing to look patient, not
 * an expectation: the ordinary close lands inside the first interval.
 */

import type { RunRepo } from "@workspace/db";
import type { RunId, WorkspaceId } from "@workspace/domain";
import { isRunLive } from "@workspace/domain";
import { Duration, Effect } from "effect";

/** How long between two reads of the same row. */
export const SETTLE_INTERVAL_MS = 500;

/** How long a reader waits in total before taking what it has. */
export const SETTLE_WINDOW_MS = 10_000;

/**
 * Re-read until the value has settled, or until the window is spent.
 *
 * Answers the last value read either way: a caller that waited out the window
 * has a fact about the database, not an error, and what it says about that fact
 * is its own decision.
 */
export const settle = <A, E, R>(options: {
  readonly intervalMs?: number;
  readonly read: Effect.Effect<A, E, R>;
  readonly settled: (value: A) => boolean;
  readonly windowMs?: number;
}) =>
  Effect.gen(function* () {
    const intervalMs = Math.max(1, options.intervalMs ?? SETTLE_INTERVAL_MS);
    const attempts = Math.floor(
      (options.windowMs ?? SETTLE_WINDOW_MS) / intervalMs
    );

    let value = yield* options.read;
    for (
      let attempt = 0;
      attempt < attempts && !options.settled(value);
      attempt += 1
    ) {
      yield* Effect.sleep(Duration.millis(intervalMs));
      value = yield* options.read;
    }
    return value;
  });

/**
 * One run, re-read until it is no longer live.
 *
 * A run that has been deleted — or was never visible to this connection — is
 * null and settled: there is nothing further to wait for.
 */
export const settledRun = (options: {
  readonly intervalMs?: number;
  readonly runId: RunId;
  readonly runs: RunRepo["Service"];
  readonly windowMs?: number;
  readonly workspaceId: WorkspaceId;
}) =>
  settle({
    intervalMs: options.intervalMs,
    read: options.runs
      .byId({ id: options.runId, workspaceId: options.workspaceId })
      .pipe(Effect.catchTag("Db.NotFound", () => Effect.succeed(null))),
    settled: (run) => run === null || !isRunLive(run),
    windowMs: options.windowMs,
  });
