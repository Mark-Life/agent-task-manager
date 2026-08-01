/**
 * The one event model every provider is normalized into, and the total mapping
 * from it onto the domain's run events.
 *
 * A provider's own stream is an implementation detail that changes with every
 * SDK release — Claude speaks partial messages and system subtypes, Codex
 * speaks thread items — so nothing above this file ever sees one. What it sees
 * is this union, written so that the orchestrator's job is a `switch` with no
 * arithmetic in it: {@link runEventKindOf} says which `RunEventKind` an event
 * becomes, and every field a `RunEventPayload` wants is either here under the
 * same name or is something only the caller knows (`promptChars`,
 * `sandboxImage`, the id of the command that stopped the run).
 *
 * Two rules shape the field list. Economics are nullable everywhere, because a
 * subscription run reports no dollar cost and an interrupted one reports
 * nothing at all — a `0` there is a number someone later averages. And content
 * is carried only where the domain already decided to carry it: an assistant
 * message and a tool summary are bounded text a reader wants, reasoning is
 * measured and never quoted, and nothing here is ever a prompt.
 *
 * Text is emitted per message, not per token. The dashboard replays this stream
 * out of Postgres, and a row per delta would be a hundred thousand rows for a
 * long turn to render the same paragraph.
 */

import {
  CostUsd,
  type RunEventKind,
  RunLogLevel,
  type RunOutcome,
  SessionProvider,
} from "@workspace/domain";
import { Schema } from "effect";
import { HarnessErrorClass, TurnOutcome } from "./errors";

/**
 * Decimal places kept when a provider's floating-point cost becomes the exact
 * decimal string the database holds. Six is a hundredth of a cent — below
 * anything a provider bills — and fixed-point formatting is also what keeps a
 * very small cost out of exponent notation, which the column's pattern rejects.
 */
const COST_DECIMALS = 6;

/**
 * A provider's cost as the domain holds it, or null when it reported none.
 * The single conversion point: providers hand out floats, the database stores
 * an exact decimal, and a `0` for "did not say" is the thing this exists to
 * prevent.
 */
export const costUsdOf = (value: number | null | undefined) =>
  typeof value === "number" && Number.isFinite(value)
    ? CostUsd.make(value.toFixed(COST_DECIMALS))
    : null;

/**
 * How a provider's rate-limit signal ranks. `allowed_warning` is the one worth
 * having: it is the only reading that arrives before a run starts failing.
 */
export const RATE_LIMIT_STATUSES = [
  "allowed",
  "allowed_warning",
  "rejected",
] as const;

/** A subscription rate-limit reading, where the provider reports one. */
export const RateLimitStatus = Schema.Literals(RATE_LIMIT_STATUSES);
export type RateLimitStatus = typeof RateLimitStatus.Type;

/**
 * The provider handed out its session id. First event of every turn, and the
 * only place the id a resume needs comes from. Becomes a `started` run event
 * once the caller adds the `promptChars` and `sandboxImage` it alone knows.
 */
const SessionInit = Schema.Struct({
  kind: Schema.tag("session_init"),
  /** What the provider actually chose, which is not always what was asked for. */
  model: Schema.NullOr(Schema.String),
  provider: SessionProvider,
  /** The provider's own id for this conversation, stored apart from ours. */
  providerSessionId: Schema.String,
});

/**
 * A complete assistant message. `text` is unclipped here — the ingest owns the
 * clip, because it is the only writer that knows the budget and can record what
 * the original length was.
 */
const AssistantText = Schema.Struct({
  kind: Schema.tag("assistant_text"),
  text: Schema.String,
});

/**
 * The model thought. Measured, never quoted: reasoning text is the one thing
 * both providers treat as private and signed, and a stored copy is a liability
 * with no reader.
 */
const Reasoning = Schema.Struct({
  chars: Schema.Natural,
  /** Null where the provider reports no timing, which is most non-streaming paths. */
  durationMs: Schema.NullOr(Schema.Natural),
  kind: Schema.tag("reasoning"),
});

/**
 * The agent invoked a tool. `summary` is the short, already-shortened
 * description a reader wants; the argv is deliberately absent, because a `git`
 * or `gh` command line carries a token.
 */
const ToolCall = Schema.Struct({
  /** Pairs this call to its result. Provider-supplied where possible, minted otherwise. */
  callId: Schema.String,
  inputChars: Schema.Natural,
  kind: Schema.tag("tool_call"),
  summary: Schema.String,
  toolName: Schema.String,
});

/** What the tool gave back, paired to its call by `callId`. */
const ToolResult = Schema.Struct({
  callId: Schema.String,
  kind: Schema.tag("tool_result"),
  ok: Schema.Boolean,
  outputChars: Schema.Natural,
  summary: Schema.String,
});

/**
 * A cost, token and rate-limit reading mid-turn. Every field is nullable
 * independently, because the providers report different subsets: Claude gives
 * cost and rate limits under a subscription, Codex gives tokens and no dollars
 * at all.
 */
const Usage = Schema.Struct({
  costUsd: Schema.NullOr(CostUsd),
  inputTokens: Schema.NullOr(Schema.Natural),
  kind: Schema.tag("usage"),
  outputTokens: Schema.NullOr(Schema.Natural),
  /** Utilization of the window the provider flagged, 0–100. */
  rateLimitPct: Schema.NullOr(Schema.Number),
  /** Unix milliseconds the flagged window rolls over. */
  rateLimitResetsAtMs: Schema.NullOr(Schema.Number),
  rateLimitStatus: Schema.NullOr(RateLimitStatus),
  /** Which window the provider named — `5h`, `weekly`. Free text; the provider owns it. */
  rateLimitType: Schema.NullOr(Schema.String),
  turns: Schema.NullOr(Schema.Natural),
});

/**
 * The agent delegated to a subagent. Kept in the stream rather than only in the
 * turn's fan-out count, because "which subagent was running when this went
 * wrong" is otherwise unanswerable.
 */
const SubagentStarted = Schema.Struct({
  description: Schema.String,
  kind: Schema.tag("subagent_started"),
  subagentId: Schema.String,
});

/** A subagent finished, with whatever economics the provider attributed to it. */
const SubagentDone = Schema.Struct({
  description: Schema.String,
  durationMs: Schema.NullOr(Schema.Natural),
  kind: Schema.tag("subagent_done"),
  /** The provider's own word for how it went; not our outcome union. */
  status: Schema.String,
  subagentId: Schema.String,
  toolUses: Schema.NullOr(Schema.Natural),
  totalTokens: Schema.NullOr(Schema.Natural),
});

/** Live narration from the harness itself, not from the model. */
const Log = Schema.Struct({
  kind: Schema.tag("log"),
  level: RunLogLevel,
  message: Schema.String,
});

/**
 * Something went wrong inside the turn without ending it — a tool that failed,
 * a retried request. The turn's own failure is the terminus below, and reading
 * one of these as a failed run is how a recovered error becomes a false alarm.
 */
const ErrorEvent = Schema.Struct({
  errorClass: HarnessErrorClass,
  errorMessage: Schema.String,
  kind: Schema.tag("error"),
});

/**
 * The terminus. Exactly one per turn, on every path including the failed ones,
 * so a stream that ends without it is the `no_terminal_event` outcome rather
 * than silence. The economics are the turn's roll-up and stay null on the
 * degraded outcomes.
 */
const Result = Schema.Struct({
  costUsd: Schema.NullOr(CostUsd),
  durationMs: Schema.NullOr(Schema.Natural),
  /** Set on every outcome but `done`, from the tag that picked the outcome. */
  errorClass: Schema.NullOr(HarnessErrorClass),
  errorMessage: Schema.NullOr(Schema.String),
  kind: Schema.tag("result"),
  outcome: TurnOutcome,
  /** Null when the provider never reported one, which is every crash before the first turn. */
  providerSessionId: Schema.NullOr(Schema.String),
  /** The final assistant message, which the stop hook reads. Empty when the turn produced none. */
  text: Schema.String,
  totalTokens: Schema.NullOr(Schema.Natural),
  turns: Schema.NullOr(Schema.Natural),
});

/**
 * One normalized thing a provider did. Tagged on `kind`, the same discriminator
 * the domain's run events use, so the tag survives the hop into the database
 * unchanged.
 */
export const AgentEvent = Schema.Union([
  SessionInit,
  AssistantText,
  Reasoning,
  ToolCall,
  ToolResult,
  Usage,
  SubagentStarted,
  SubagentDone,
  Log,
  ErrorEvent,
  Result,
]).pipe(Schema.toTaggedUnion("kind"));
export type AgentEvent = typeof AgentEvent.Type;

/** The discriminator of a normalized event. Derived, so it cannot drift. */
export type AgentEventKind = AgentEvent["kind"];

/**
 * One line of the run's event file: the event, and the clock inside the
 * container that saw it. Both clocks matter — the host stamps its own
 * `created_at` at ingest, and the gap between them is the ingest lag.
 */
export const AgentEventRecord = Schema.Struct({
  event: AgentEvent,
  occurredAt: Schema.DateTimeUtcFromString,
});

export interface AgentEventRecord
  extends Schema.Schema.Type<typeof AgentEventRecord> {}

/**
 * Which run event each kind becomes, for everything but the terminus.
 *
 * Subagent lifecycle lands as `log`: the domain has no subagent kind, the
 * fan-out counts ride the turn's wide event, and inventing a run-event kind for
 * it would put a migration between the harness and the timeline.
 */
const RUN_EVENT_KIND_OF = {
  assistant_text: "assistant_message",
  error: "error",
  log: "log",
  reasoning: "reasoning",
  session_init: "started",
  subagent_done: "log",
  subagent_started: "log",
  tool_call: "tool_call",
  tool_result: "tool_result",
  usage: "usage",
} as const satisfies Record<Exclude<AgentEventKind, "result">, RunEventKind>;

/**
 * How a turn's terminus becomes a run outcome. `no_terminal_event` is the
 * domain's `lost`: the two words describe the same run from the two ends of it,
 * the harness saw a stream stop and the orchestrator sees a run that never
 * reported back.
 */
const RUN_OUTCOME_OF_TURN = {
  done: "done",
  errored: "errored",
  interrupted: "interrupted",
  no_terminal_event: "lost",
  timeout: "timeout",
} as const satisfies Record<TurnOutcome, RunOutcome>;

/** The run outcome a turn outcome records. Total over both unions. */
export const runOutcomeOf = (outcome: TurnOutcome) =>
  RUN_OUTCOME_OF_TURN[outcome];

/**
 * The run event kind this event becomes. Total by construction: the record
 * above covers every kind but the terminus, and the terminus splits on its own
 * outcome.
 *
 * A cleanly finished turn is `finished` and everything else is `failed`.
 * `stopped` is never produced here — it names the command that killed the run,
 * and only the orchestrator holds that id.
 */
export const runEventKindOf = (event: AgentEvent): RunEventKind => {
  if (event.kind === "result") {
    return event.outcome === "done" ? "finished" : "failed";
  }
  return RUN_EVENT_KIND_OF[event.kind];
};

/** Whether this event ends the turn. The one event a consumer must see. */
export const isTerminal = (event: AgentEvent) => event.kind === "result";
