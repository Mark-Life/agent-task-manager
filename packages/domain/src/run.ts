import { Schema } from "effect";
import {
  RunOutcome,
  RunRole,
  RunStatus,
  RunTrigger,
  SessionProvider,
} from "./enums";
import { AgentSessionId, RunId, TaskId, ThreadId } from "./ids";
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

/** Work on a task. */
const TaskSubject = Schema.Struct({
  id: TaskId,
  kind: Schema.tag("task"),
});

/** Work on a conversation. */
const ThreadSubject = Schema.Struct({
  id: ThreadId,
  kind: Schema.tag("thread"),
});

/**
 * What a run is attached to. A union rather than two nullable ids, because the
 * role and the attachment are one fact: a worker always has a task and a
 * manager always has a thread, and two independent fields would make the other
 * two combinations representable.
 *
 * Foreign keys stay foreign keys on the row — `task_id` and `thread_id` are
 * real columns with real references — and this is how a caller names one.
 */
export const RunSubject = Schema.Union([TaskSubject, ThreadSubject]).pipe(
  Schema.toTaggedUnion("kind")
);
export type RunSubject = typeof RunSubject.Type;

/** One mapping, so a role can never be written to disagree with what it is attached to. */
const ROLE_OF_KIND = {
  task: "worker",
  thread: "manager",
} as const satisfies Record<RunSubject["kind"], RunRole>;

/** The role that follows from what a run is attached to. There is no other source of it. */
export const roleOfSubject = (subject: RunSubject) =>
  ROLE_OF_KIND[subject.kind];

/**
 * One attempt at a piece of work, inside one session. The economics are
 * nullable throughout: a degraded run did not cost 0 and did not take 0ms, it
 * produced no number at all, and a fabricated 0 is a number someone later
 * averages.
 *
 * `taskId` and `threadId` are the two halves of {@link RunSubject}: exactly
 * one is set, and which one is `role`. The database refuses every other
 * combination, so reading the role is enough to know which id is there.
 */
export const Run = Schema.Struct({
  ...recordFields,
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
  role: RunRole,
  /** Which image actually ran, against `task.sandboxImage`, which only selects one. */
  sandboxImage: Schema.NullOr(Schema.String),
  /** Null while queued, so the queue wait is `startedAt - createdAt`. */
  startedAt: Schema.NullOr(Timestamp),
  status: RunStatus,
  /** Set on a worker run, null on a manager one. */
  taskId: Schema.NullOr(TaskId),
  /** Set on a manager run, null on a worker one. */
  threadId: Schema.NullOr(ThreadId),
  totalTokens: Schema.NullOr(Schema.Natural),
  /** Joins this row to its `atm.run` ledger event. */
  traceId: Schema.NullOr(Schema.String),
  trigger: RunTrigger,
  turns: Schema.NullOr(Schema.Natural),
});

export interface Run extends Schema.Schema.Type<typeof Run> {}
