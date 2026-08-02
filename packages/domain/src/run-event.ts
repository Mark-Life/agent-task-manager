import { Schema } from "effect";
import { ActorKind, RunLogLevel, RunOutcome, SessionProvider } from "./enums";
import {
  RunCommandId,
  RunEventId,
  RunId,
  TaskId,
  ThreadId,
  UserId,
} from "./ids";
import { appendOnlyFields, CostUsd, Timestamp } from "./primitives";

/**
 * The clip a run event's free text is held to before insert, in bytes. Content
 * is measured rather than carried everywhere else in this system; a run event
 * is the one place a little text is genuinely useful to a reader, so it is
 * bounded instead of banned. The full text is in the transcript on disk.
 *
 * The clip itself belongs to whoever turns a harness event into one of these —
 * the transcript ingest — because only the writer knows which field of a
 * payload is safe to cut, and a clipped field carries `truncated` and
 * `originalChars` beside it so the cut is visible to a reader. The repository
 * only refuses what is already too big.
 */
export const RUN_EVENT_TEXT_BUDGET_BYTES = 16_384;

/** The same clip for the short fields: every summary, log message and error message. */
export const RUN_EVENT_SUMMARY_BUDGET_BYTES = 2048;

/**
 * The hard ceiling the database checks on the stored payload, so a chatty run
 * cannot put megabytes into the write-ahead log and every backup forever.
 */
export const RUN_EVENT_PAYLOAD_MAX_BYTES = 65_536;

/**
 * What a writer is held to, below the ceiling above.
 *
 * The two measure different things: the database sizes the stored `jsonb`,
 * while a writer can only size the JSON text it is about to send, and `jsonb`
 * carries per-key and per-element headers that can make it the larger of the
 * two. The margin is what makes the writer's check a real bound on the
 * database's, whichever way the representations differ, so the constraint is
 * never the thing that fires.
 */
export const RUN_EVENT_PAYLOAD_BUDGET_BYTES = 61_440;

/** A run began: what it was going to run, and how much prompt it was given. */
const StartedPayload = Schema.Struct({
  kind: Schema.tag("started"),
  model: Schema.NullOr(Schema.String),
  promptChars: Schema.Natural,
  provider: SessionProvider,
  sandboxImage: Schema.NullOr(Schema.String),
});

/** Something the agent said. Clipped, with the original size beside it so the clip is visible. */
const AssistantMessagePayload = Schema.Struct({
  chars: Schema.Natural,
  kind: Schema.tag("assistant_message"),
  originalChars: Schema.optionalKey(Schema.Natural),
  text: Schema.String,
  truncated: Schema.optionalKey(Schema.Boolean),
});

/** How much the agent thought. Never the reasoning itself. */
const ReasoningPayload = Schema.Struct({
  chars: Schema.Natural,
  kind: Schema.tag("reasoning"),
});

/** A tool invocation. The summary is sanitized and the argv is never stored — a `gh` or `git` command line carries a token. */
const ToolCallPayload = Schema.Struct({
  callId: Schema.String,
  inputChars: Schema.Natural,
  kind: Schema.tag("tool_call"),
  summary: Schema.String,
  toolName: Schema.String,
});

/** What the tool gave back, paired to its call by `callId`. */
const ToolResultPayload = Schema.Struct({
  callId: Schema.String,
  kind: Schema.tag("tool_result"),
  ok: Schema.Boolean,
  outputChars: Schema.Natural,
  summary: Schema.String,
});

/** A cost and rate-limit reading mid-run, which is what the quota gate watches. */
const UsagePayload = Schema.Struct({
  costUsd: Schema.NullOr(CostUsd),
  inputTokens: Schema.Natural,
  kind: Schema.tag("usage"),
  outputTokens: Schema.Natural,
  rateLimitPct: Schema.NullOr(Schema.Number),
  turns: Schema.Natural,
});

/** Live narration from the harness or the orchestrator. */
const LogPayload = Schema.Struct({
  kind: Schema.tag("log"),
  level: RunLogLevel,
  message: Schema.String,
});

/** A recoverable error inside the run, which is not the same as the run failing. */
const ErrorPayload = Schema.Struct({
  errorClass: Schema.String,
  errorMessage: Schema.String,
  kind: Schema.tag("error"),
});

/** The clean terminus, with the run's rolled-up economics. */
const FinishedPayload = Schema.Struct({
  costUsd: Schema.NullOr(CostUsd),
  durationMs: Schema.Natural,
  kind: Schema.tag("finished"),
  outcome: RunOutcome,
  totalTokens: Schema.Natural,
  turns: Schema.Natural,
});

/** The crashing terminus. */
const FailedPayload = Schema.Struct({
  errorClass: Schema.String,
  errorMessage: Schema.String,
  exitCode: Schema.NullOr(Schema.Int),
  kind: Schema.tag("failed"),
});

/** The run was killed on purpose, by the command named here. */
const StoppedPayload = Schema.Struct({
  commandId: RunCommandId,
  kind: Schema.tag("stopped"),
  requestedByKind: ActorKind,
  requestedByUserId: Schema.optionalKey(UserId),
});

/**
 * What a run event says, keyed by its kind. The row splits this in two — `kind`
 * is a column and the rest is the jsonb blob — so the tag is never written
 * twice and the two can never disagree; {@link splitPayload} is that split.
 */
export const RunEventPayload = Schema.Union([
  StartedPayload,
  AssistantMessagePayload,
  ReasoningPayload,
  ToolCallPayload,
  ToolResultPayload,
  UsagePayload,
  LogPayload,
  ErrorPayload,
  FinishedPayload,
  FailedPayload,
  StoppedPayload,
]).pipe(Schema.toTaggedUnion("kind"));
export type RunEventPayload = typeof RunEventPayload.Type;

/**
 * One line of a run's normalized event stream. Append-only, and the live
 * stream, the audit of what an agent did, and the dashboard's replay source are
 * all this one table.
 */
export const RunEvent = Schema.Struct({
  ...appendOnlyFields,
  id: RunEventId,
  /** The harness clock, inside the container. Differs from `createdAt` on the host, and both matter. */
  occurredAt: Timestamp,
  payload: RunEventPayload,
  runId: RunId,
  /**
   * The 0-based line ordinal of the event in the container's event file, not a
   * counter. Re-ingesting the same file therefore collides on `(runId, seq)` by
   * construction, which is what makes re-ingest idempotent rather than
   * duplicating a run's whole timeline.
   */
  seq: Schema.Natural,
  /** Denormalized, so a subscriber filters one task's stream without a join. Null on a manager run. */
  taskId: Schema.NullOr(TaskId),
  /** The same, for a conversation's turns. Null on a worker run. */
  threadId: Schema.NullOr(ThreadId),
});

export interface RunEvent extends Schema.Schema.Type<typeof RunEvent> {}
