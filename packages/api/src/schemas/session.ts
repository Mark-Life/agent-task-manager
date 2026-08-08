/**
 * An agent session on the wire, and the transcript behind it.
 *
 * The session is the domain entity. The transcript is not: there is no table
 * for transcript messages and the design says there should not be one — the
 * file the provider wrote is the record, read back off disk. So the two
 * transcript schemas here restate the shape `@workspace/harness` parses a
 * transcript into, because that package sits on the other side of the harness
 * seam and this one may not import it. They are the wire's copy of it and must
 * be kept in step by hand; a drift is a decode failure at the boundary, not a
 * silent one.
 */

import {
  AgentSession as DomainAgentSession,
  AgentSessionUsage as DomainAgentSessionUsage,
} from "@workspace/domain";
import { Schema } from "effect";

/** One agent conversation on a task, exactly as the store holds it. */
export const AgentSession = DomainAgentSession.annotate({
  identifier: "AgentSession",
});

export interface AgentSession extends Schema.Schema.Type<typeof AgentSession> {}

/**
 * What one session spent, exactly as the store holds it.
 *
 * The domain schema unchanged, unlike the transcript below: this one is a
 * domain entity with a table behind it, so there is nothing here to restate and
 * nothing to keep in step by hand.
 */
export const AgentSessionUsage = DomainAgentSessionUsage.annotate({
  identifier: "AgentSessionUsage",
});

export interface AgentSessionUsage
  extends Schema.Schema.Type<typeof AgentSessionUsage> {}

/**
 * What produced one line of the conversation. Deliberately not either
 * provider's own role vocabulary: both fold tool traffic into the user and
 * assistant roles, and a role a reader has to open the content to interpret is
 * not a role.
 */
export const TRANSCRIPT_ROLES = [
  "assistant",
  "reasoning",
  "system",
  "tool_call",
  "tool_result",
  "user",
] as const;

/** Who or what produced a transcript entry. */
export const TranscriptRole = Schema.Literals(TRANSCRIPT_ROLES);
export type TranscriptRole = typeof TranscriptRole.Type;

/**
 * One thing that happened in a conversation, as the provider recorded it.
 *
 * `chars` measures what the provider produced and `text` is what is kept, so
 * the two agree everywhere except on reasoning, where the count is the size of
 * the model's thinking and the text is empty — a measured-but-not-carried entry
 * still has to be countable.
 */
export const TranscriptEntry = Schema.Struct({
  /** Pairs a call to its result. Null on everything that is not tool traffic. */
  callId: Schema.NullOr(Schema.String),
  /** Length of what the provider produced, which is `text.length` except on reasoning. */
  chars: Schema.Natural,
  /** The 0-based line of the file this came from. Several entries share a line when one message held several blocks. */
  line: Schema.Natural,
  /** The provider's own stamp, verbatim, or null on the lines that carry none. */
  occurredAt: Schema.NullOr(Schema.String),
  /** Whether a tool succeeded. Null where the provider does not say, which is not false. */
  ok: Schema.NullOr(Schema.Boolean),
  role: TranscriptRole,
  text: Schema.String,
  /** Null on everything that is not tool traffic. */
  toolName: Schema.NullOr(Schema.String),
}).annotate({ identifier: "TranscriptEntry" });

export interface TranscriptEntry
  extends Schema.Schema.Type<typeof TranscriptEntry> {}

/**
 * What one model request cost, as the provider recorded it.
 *
 * A stream beside the conversation rather than a field on an entry, because one
 * response is written as several entries — some prose and four tool calls — and
 * a reading repeated on each of them is a reading that gets summed five times.
 * Every field is nullable because the two providers report different halves of
 * the same picture and a zero standing in for silence is a lie about both.
 */
export const TranscriptUsage = Schema.Struct({
  cacheRead: Schema.NullOr(Schema.Natural),
  cacheWrite: Schema.NullOr(Schema.Natural),
  /** The one-hour part of the cache write, which Claude bills at twice input. */
  cacheWrite1h: Schema.NullOr(Schema.Natural),
  cacheWrite5m: Schema.NullOr(Schema.Natural),
  /** What the request put in front of the model: fresh input plus cache reads plus cache writes. */
  context: Schema.Natural,
  /** The provider's own window, where it records one. Claude does not. */
  contextWindow: Schema.NullOr(Schema.Natural),
  /** Fresh prompt tokens — normalized to that meaning on both providers. */
  input: Schema.NullOr(Schema.Natural),
  line: Schema.Natural,
  model: Schema.NullOr(Schema.String),
  occurredAt: Schema.NullOr(Schema.String),
  output: Schema.NullOr(Schema.Natural),
  /** The thinking half of output, where the provider separates it. Claude does not. */
  reasoningOutput: Schema.NullOr(Schema.Natural),
  /** The speed tier, where the provider names one. Fast mode is twice the price. */
  speed: Schema.NullOr(Schema.String),
}).annotate({ identifier: "TranscriptUsage" });

export interface TranscriptUsage
  extends Schema.Schema.Type<typeof TranscriptUsage> {}

/**
 * One session's conversation, in file order, which is the order things
 * happened, and what each of its requests cost. A session whose run left no
 * file reads as an empty transcript rather than a 404: nothing said is a real
 * answer.
 */
export const Transcript = Schema.Struct({
  entries: Schema.Array(TranscriptEntry),
  /** The provider's own session id, as the file names or declares it. Null when the file never said. */
  providerSessionId: Schema.NullOr(Schema.String),
  usage: Schema.Array(TranscriptUsage),
}).annotate({ identifier: "Transcript" });

export interface Transcript extends Schema.Schema.Type<typeof Transcript> {}
