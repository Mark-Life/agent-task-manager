import { Schema } from "effect";
import { RunOutcome, RunStatus, RunTrigger, SessionProvider } from "./enums";
import { AgentSessionId, RunId, TaskId } from "./ids";
import { CostUsd, recordFields, Timestamp } from "./primitives";

/**
 * The statuses that mean a container is, or is about to be, working. A live run
 * is not the same fact as a task sitting in `in_progress`: a task in that
 * column with no live run is waiting for a slot or has stalled, and the board
 * shows the difference. One partial unique index over these statuses is also
 * what stops two agents writing the same artifacts directory.
 */
export const LIVE_RUN_STATUSES = ["queued", "running"] as const;

/** Whether a container is working on this run right now. */
export const isRunLive = (run: Pick<Run, "status">) =>
  (LIVE_RUN_STATUSES as readonly RunStatus[]).includes(run.status);

/**
 * One attempt at a task, inside one session. The economics are nullable
 * throughout: a degraded run did not cost 0 and did not take 0ms, it produced
 * no number at all, and a fabricated 0 is a number someone later averages.
 */
export const Run = Schema.Struct({
  ...recordFields,
  /** This run's agent-home dir, relative to the data root. Per run, not per session: parallel containers sharing one credentials file invalidate each other. */
  agentHomePath: Schema.NullOr(Schema.String),
  /** Every run belongs to a session — that is what resume means — and the session row is written first, in the same transaction. */
  agentSessionId: AgentSessionId,
  attempt: Schema.Natural,
  /** The branch this run pushed, which is the PR's head. */
  branch: Schema.NullOr(Schema.String),
  /** Kept for teardown and a post-mortem `docker logs`. */
  containerId: Schema.NullOr(Schema.String),
  costUsd: Schema.NullOr(CostUsd),
  durationMs: Schema.NullOr(Schema.Natural),
  /** Sanitized. */
  errorClass: Schema.NullOr(Schema.String),
  /** Sanitized and clipped. */
  errorMessage: Schema.NullOr(Schema.String),
  /** Distinguishes a crash from a clean finish. */
  exitCode: Schema.NullOr(Schema.Int),
  finishedAt: Schema.NullOr(Timestamp),
  id: RunId,
  /** Unknown until the harness reports it. */
  model: Schema.NullOr(Schema.String),
  /** Null while the run is live. Never a fabricated terminus. */
  outcome: Schema.NullOr(RunOutcome),
  provider: SessionProvider,
  /** Which image actually ran, against `task.sandboxImage`, which only selects one. */
  sandboxImage: Schema.NullOr(Schema.String),
  /** Null while queued, so the queue wait is `startedAt - createdAt`. */
  startedAt: Schema.NullOr(Timestamp),
  status: RunStatus,
  taskId: TaskId,
  totalTokens: Schema.NullOr(Schema.Natural),
  /** Joins this row to its `atm.run` ledger event. */
  traceId: Schema.NullOr(Schema.String),
  trigger: RunTrigger,
  turns: Schema.NullOr(Schema.Natural),
});

export interface Run extends Schema.Schema.Type<typeof Run> {}
