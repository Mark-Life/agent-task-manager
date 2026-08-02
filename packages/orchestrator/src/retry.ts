/**
 * What happens after an attempt fails, and what stops a broken task from
 * spending every slot on the box forever.
 *
 * There is one mechanism and it has two settings. A failed attempt stamps
 * `task.parkedUntil` with the moment the next one may start; the dispatcher
 * skips a task whose stamp is in the future, so the wait is a column rather than
 * a sleeping fiber and a loop that restarts mid-backoff resumes the ladder
 * instead of starting it again. Once the attempts are spent, the same column is
 * stamped a day out and the task is parked — the loop stops re-dispatching, and
 * the card sits in *in progress* with nothing running on it, which is the
 * visible "a human needs to look at this" the design asks for.
 *
 * Un-parking is deliberately not here. `TaskRepo.transition` clears the column
 * when a person moves the task into *in progress*, because that move is exactly
 * the signal that the loop should resume; a second implementation of that rule
 * in the loop would be a second thing to keep in step with the audit row the
 * repository already writes.
 *
 * The arithmetic lives in `./config` beside the knobs it reads, and this module
 * is the decision and the write over it: which of the two stampings a failed
 * attempt earns, when the wait ends, and whether a task read back off the board
 * is still inside one.
 */

import { TaskRepo } from "@workspace/db";
import type { Task, TaskId, WorkspaceId } from "@workspace/domain";
import { Clock, DateTime, Effect } from "effect";
import {
  type OrchestratorConfig,
  type RetryPolicy,
  retryDelayMs,
  shouldPark,
} from "./config";

/**
 * Everything the ladder reads: the backoff knobs plus how long a park lasts.
 * Derived from the loop's config rather than restated, so a renamed knob is a
 * compile error here.
 */
export interface RetryConfig
  extends RetryPolicy,
    Pick<OrchestratorConfig, "parkMs"> {}

/** The two ways a failed attempt ends. */
export const RETRY_DECISIONS = ["retry", "park"] as const;

/** Whether the task waits and tries again, or stops until a person says otherwise. */
export type RetryDecisionKind = (typeof RETRY_DECISIONS)[number];

/** What both decisions carry: how long the task waits, and until when. */
interface RetryDecisionBase {
  /** 1-based number of the attempt that just failed. */
  readonly attempt: number;
  readonly delayMs: number;
  /** Unix milliseconds the wait ends, which is what lands in `parkedUntil`. */
  readonly resumesAtMs: number;
}

/** The task waits out the backoff and the dispatcher picks it up again after. */
export interface RetryScheduled extends RetryDecisionBase {
  readonly kind: "retry";
  /** The number the next run row carries, which is what the ladder counts from. */
  readonly nextAttempt: number;
}

/**
 * The attempts are spent. The wait is long on purpose — the real un-park is a
 * human move into *in progress*, and the expiry only exists so a transient
 * outage nobody noticed cannot park a task forever.
 */
export interface RetryParked extends RetryDecisionBase {
  readonly kind: "park";
}

/** What a failed attempt earned. */
export type RetryDecision = RetryParked | RetryScheduled;

/** What deciding needs. Pure: the clock is a number the caller read. */
export interface RetryRequest {
  /** 1-based number of the attempt that just failed. */
  readonly attempt: number;
  readonly nowMs: number;
  readonly policy: RetryConfig;
}

/**
 * Whether the attempt that just failed earns another one, and when.
 *
 * Pure and total, which is what makes the ladder testable without a database or
 * a clock: every branch of the retry story is this one function plus the two in
 * `./config` it delegates the arithmetic to.
 */
export const decideRetry = ({
  attempt,
  nowMs,
  policy,
}: RetryRequest): RetryDecision => {
  if (shouldPark({ attempt, policy })) {
    return {
      attempt,
      delayMs: policy.parkMs,
      kind: "park",
      resumesAtMs: nowMs + policy.parkMs,
    };
  }
  const delayMs = retryDelayMs({ attempt, policy });
  return {
    attempt,
    delayMs,
    kind: "retry",
    nextAttempt: attempt + 1,
    resumesAtMs: nowMs + delayMs,
  };
};

/** A task and the moment being asked about. */
export interface ParkedRequest {
  readonly nowMs: number;
  readonly parkedUntil: Task["parkedUntil"];
}

/**
 * Whether the dispatcher should skip this task right now. The one reader of the
 * column, so "parked" and "waiting out a backoff" are one question with one
 * answer rather than two comparisons that eventually differ by a millisecond.
 */
export const isParked = ({ nowMs, parkedUntil }: ParkedRequest) =>
  parkedUntil !== null && nowMs < DateTime.toEpochMillis(parkedUntil);

/** How much of the wait is left, or 0 when there is none. For the log line and the board. */
export const parkRemainingMs = ({ nowMs, parkedUntil }: ParkedRequest) =>
  parkedUntil === null
    ? 0
    : Math.max(0, DateTime.toEpochMillis(parkedUntil) - nowMs);

/** What stamping the decision onto the task needs. */
export interface StampRetryInput {
  /** 1-based number of the attempt that just failed. */
  readonly attempt: number;
  readonly policy: RetryConfig;
  readonly taskId: TaskId;
  readonly workspaceId: WorkspaceId;
}

/**
 * Decides and writes, returning what it decided so the caller's wide event can
 * report it.
 *
 * The write is `TaskRepo.update`, which means it is audited like every other
 * mutation and performed as whoever the context says — the loop, in practice.
 * Parking is loud because it is a state change somebody has to act on; a
 * backoff is narration and stays at info.
 */
export const stampRetry = Effect.fn("Retry.stamp")(function* (
  input: StampRetryInput
) {
  const nowMs = yield* Clock.currentTimeMillis;
  const decision = decideRetry({
    attempt: input.attempt,
    nowMs,
    policy: input.policy,
  });

  const tasks = yield* TaskRepo;
  yield* tasks.update({
    fields: { parkedUntil: DateTime.makeUnsafe(decision.resumesAtMs) },
    id: input.taskId,
    workspaceId: input.workspaceId,
  });

  yield* Effect.annotateCurrentSpan({
    attempt: decision.attempt,
    decision: decision.kind,
    delayMs: decision.delayMs,
    taskId: input.taskId,
  });

  yield* decision.kind === "park"
    ? Effect.logWarning(
        `retries exhausted — task ${input.taskId} parked after ${decision.attempt} attempts`
      )
    : Effect.logInfo(
        `attempt ${decision.attempt} failed — task ${input.taskId} retries in ${decision.delayMs}ms`
      );

  return decision;
});
