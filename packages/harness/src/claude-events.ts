/**
 * Every SDK message this harness understands, and the normalized event it
 * becomes.
 *
 * The Agent SDK's message union grows with each release and almost none of it
 * is something the orchestrator should have to know about — partial frames,
 * hook lifecycle, status pings, thirty tags that mean "still working". This
 * file is the whole of that knowledge, and it is pure: every function here maps
 * a message to events with no I/O and no SDK call, so what a turn reports can
 * be asserted from a fixture instead of from a live model.
 *
 * Two rules shape what crosses over. Content is measured, never carried:
 * reasoning becomes a character count, a shell command becomes its verb, a
 * fetched URL loses its query string. And a number is reported only when the
 * provider reported one — null everywhere else, because a `0` on a turn that
 * never finished is a number someone later averages.
 */

import type {
  SDKAssistantMessageError,
  SDKMessage,
  SDKResultError,
} from "@anthropic-ai/claude-agent-sdk";
import type { SessionProvider } from "@workspace/domain";
import { clipError } from "@workspace/telemetry";
import {
  classify,
  describeError,
  type HarnessErrorClass,
  NoTerminalEvent,
  outcomeOfClass,
} from "./errors";
import { type AgentEvent, costUsdOf } from "./events";
import { commandLabel, isRecord, stringOf, urlLabel } from "./tool-summary";

/** This harness's name in the domain's provider union. */
export const PROVIDER_ID: SessionProvider = "claude";

/** Nothing to emit. One shared array, since every ignored message returns it. */
const NO_EVENTS: readonly AgentEvent[] = [];

/** Every SDK message type this file understands, keyed off the `type` tag. */
type AssistantMessage = Extract<SDKMessage, { type: "assistant" }>;
type UserMessage = Extract<SDKMessage, { type: "user" }>;
type ResultMessage = Extract<SDKMessage, { type: "result" }>;
type SystemMessage = Extract<SDKMessage, { type: "system" }>;
type RateLimitMessage = Extract<SDKMessage, { type: "rate_limit_event" }>;

/** A tool's answer, as it comes back on the synthetic user message. */
type ToolResultBlock = Extract<
  Exclude<UserMessage["message"]["content"], string>[number],
  { type: "tool_result" }
>;

/**
 * Which field of a tool's input reads as its summary. Anything absent from this
 * map summarizes as nothing at all — an unknown tool's input is an unknown
 * shape, and guessing at it is how a credential ends up on the timeline.
 *
 * `Skill` is on the list because a skill name is not caller text: it is a slug
 * off the repository's own skill directory, a closed vocabulary a reader can
 * enumerate. Without it every skill call summarized as nothing and which
 * skills a run actually used could not be counted at all.
 */
const TOOL_SUMMARY_FIELD: Readonly<Record<string, string>> = {
  Edit: "file_path",
  Glob: "pattern",
  Grep: "pattern",
  Read: "file_path",
  Skill: "skill",
  Task: "description",
  WebFetch: "url",
  WebSearch: "query",
  Write: "file_path",
};

/** Milliseconds in a second, for reading the rate-limit reset stamp. */
const MILLIS_PER_SECOND = 1000;

/**
 * Above this an epoch stamp cannot be seconds — it would be the year 5138 —
 * and below it it cannot be milliseconds, since that would be before 1973.
 */
const EPOCH_SECONDS_CEILING = 1e11;

/** The short description of a tool call a reader wants, and nothing more. */
const toolSummary = (
  name: string,
  input: Readonly<Record<string, unknown>>
) => {
  if (name === "Bash") {
    return commandLabel(stringOf(input.command));
  }
  if (name === "WebFetch") {
    return urlLabel(stringOf(input.url));
  }
  const field = TOOL_SUMMARY_FIELD[name];
  return field === undefined ? "" : clipError(stringOf(input[field]));
};

/**
 * A count as the event schema holds it: a non-negative integer, or null where
 * the provider reported nothing. Rounded rather than refused, because a
 * fractional millisecond arriving from the SDK should not fail a whole turn.
 */
const naturalOf = (value: number | null | undefined) =>
  typeof value === "number" && Number.isFinite(value) && value >= 0
    ? Math.round(value)
    : null;

/** Every token the turn touched, cache included, or null when none were reported. */
const tokensOf = (usage: ResultMessage["usage"]) => {
  const counts = [
    usage.input_tokens,
    usage.output_tokens,
    usage.cache_creation_input_tokens,
    usage.cache_read_input_tokens,
  ].filter((count): count is number => typeof count === "number");
  return counts.length > 0
    ? counts.reduce((total, count) => total + count, 0)
    : null;
};

/**
 * The rate-limit reset stamp in milliseconds. The provider reports it in
 * seconds, but the magnitude says which unit it is without anyone having to
 * trust that, and silently storing seconds in a field named `Ms` would put a
 * reset date in 1970 on every dashboard that reads it.
 */
const epochMillisOf = (value: number | undefined) => {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return null;
  }
  return value < EPOCH_SECONDS_CEILING
    ? Math.round(value * MILLIS_PER_SECOND)
    : Math.round(value);
};

/**
 * What the SDK's own error names mean in our vocabulary. Written out rather
 * than sniffed from the text, so a new SDK error literal is a build error here
 * instead of an `Unknown` nobody notices.
 */
const CLASS_OF_SDK_ERROR = {
  authentication_failed: "Unauthenticated",
  billing_error: "QuotaExhausted",
  invalid_request: "Unknown",
  max_output_tokens: "Unknown",
  model_not_found: "Unknown",
  oauth_org_not_allowed: "Unauthenticated",
  overloaded: "RateLimited",
  rate_limit: "RateLimited",
  server_error: "Unknown",
  unknown: "Unknown",
} as const satisfies Record<SDKAssistantMessageError, HarnessErrorClass>;

/** What the turn learned so far, and whether it ever reached a terminus. */
export interface Cursor {
  /** Normalized events emitted, which is what a silent stream is measured by. */
  eventsSeen: number;
  providerSessionId: string | null;
  terminated: boolean;
}

/** A cursor for one turn. One per subscription, so a stream can be run twice. */
export const makeCursor = (): Cursor => ({
  eventsSeen: 0,
  providerSessionId: null,
  terminated: false,
});

/** The blocks of one complete assistant message, as normalized events. */
const assistantEvents = (message: AssistantMessage): readonly AgentEvent[] => {
  const events: AgentEvent[] = [];
  for (const block of message.message.content) {
    if (block.type === "text" && block.text.length > 0) {
      events.push({ kind: "assistant_text", text: block.text });
    } else if (block.type === "thinking") {
      // Measured, never quoted, and never timed: without partial messages the
      // SDK reports no thinking duration, and inventing one is worse than none.
      events.push({
        chars: block.thinking.length,
        durationMs: null,
        kind: "reasoning",
      });
    } else if (block.type === "tool_use") {
      const input = isRecord(block.input) ? block.input : {};
      events.push({
        callId: block.id,
        inputChars: JSON.stringify(input).length,
        kind: "tool_call",
        summary: toolSummary(block.name, input),
        toolName: block.name,
      });
    }
  }
  if (message.error !== undefined) {
    events.push({
      errorClass: CLASS_OF_SDK_ERROR[message.error],
      errorMessage: clipError(`assistant message failed: ${message.error}`),
      kind: "error",
    });
  }
  return events;
};

/** The text a tool returned, however the block chose to carry it. */
const textOfToolResult = (content: ToolResultBlock["content"]) => {
  if (typeof content === "string") {
    return content;
  }
  if (content === undefined) {
    return "";
  }
  return content
    .filter((block) => block.type === "text")
    .map((block) => block.text)
    .join("\n");
};

/**
 * Tool answers, which arrive as synthetic user messages. The summary is clipped
 * here rather than at ingest: a tool's output is the one place in a turn where
 * a `cat` of the wrong file puts a live credential into the stream.
 */
const toolResultEvents = (message: UserMessage): readonly AgentEvent[] => {
  const { content } = message.message;
  if (typeof content === "string") {
    return NO_EVENTS;
  }
  const events: AgentEvent[] = [];
  for (const block of content) {
    if (block.type === "tool_result") {
      const text = textOfToolResult(block.content);
      events.push({
        callId: block.tool_use_id,
        kind: "tool_result",
        ok: block.is_error !== true,
        outputChars: text.length,
        summary: clipError(text),
      });
    }
  }
  return events;
};

/** Session identity, subagent lifecycle, retries and compaction. */
const systemEvents = (
  cursor: Cursor,
  message: SystemMessage
): readonly AgentEvent[] => {
  switch (message.subtype) {
    case "init":
      // The one event the orchestrator persists synchronously: without this id
      // the next turn cannot resume, however well this one goes.
      cursor.providerSessionId = message.session_id;
      return [
        {
          kind: "session_init",
          model: message.model,
          provider: PROVIDER_ID,
          providerSessionId: message.session_id,
        },
      ];
    case "task_started":
      return [
        {
          description: message.description,
          kind: "subagent_started",
          subagentId: message.task_id,
        },
      ];
    case "task_notification":
      return [
        {
          description: message.summary,
          durationMs: naturalOf(message.usage?.duration_ms),
          kind: "subagent_done",
          status: message.status,
          subagentId: message.task_id,
          toolUses: naturalOf(message.usage?.tool_uses),
          totalTokens: naturalOf(message.usage?.total_tokens),
        },
      ];
    case "api_retry":
      // A retried request is an error the turn recovered from. Reading it as a
      // failed run is how a transient blip becomes a false alarm.
      return [
        {
          errorClass: CLASS_OF_SDK_ERROR[message.error],
          errorMessage: clipError(
            `api retry ${message.attempt}/${message.max_retries}: ${message.error}`
          ),
          kind: "error",
        },
      ];
    case "compact_boundary":
      return [
        {
          kind: "log",
          level: "debug",
          message: `context compacted (${message.compact_metadata.trigger})`,
        },
      ];
    default:
      return NO_EVENTS;
  }
};

/** A subscription rate-limit reading, which arrives whenever it changes. */
const rateLimitEvents = (message: RateLimitMessage): readonly AgentEvent[] => {
  const info = message.rate_limit_info;
  return [
    {
      costUsd: null,
      inputTokens: null,
      kind: "usage",
      outputTokens: null,
      rateLimitPct: info.utilization ?? null,
      rateLimitResetsAtMs: epochMillisOf(info.resetsAt),
      rateLimitStatus: info.status,
      rateLimitType: info.rateLimitType ?? null,
      turns: null,
    },
  ];
};

/** How a failed turn is named, from the provider's own words for it. */
const failureOf = (message: SDKResultError) => {
  const detail = message.errors
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .join("; ");
  const errorClass = classify({ thrown: `${message.subtype} ${detail}` });
  return {
    errorClass,
    errorMessage: clipError(detail || message.subtype),
    outcome: outcomeOfClass(errorClass),
  } as const;
};

/**
 * The terminus, plus the usage reading it rolls up.
 *
 * The economics are reported on a failed turn as well as a clean one. A turn
 * that burned three dollars before the model refused really did burn three
 * dollars, and nulling a measured number to signal "degraded" hides spend that
 * the ledger exists to add up. Null here means the provider reported nothing,
 * and only that.
 */
const resultEvents = (message: ResultMessage): readonly AgentEvent[] => {
  const costUsd = costUsdOf(message.total_cost_usd);
  const turns = naturalOf(message.num_turns);
  const failure = message.subtype === "success" ? null : failureOf(message);
  return [
    {
      costUsd,
      inputTokens: naturalOf(message.usage.input_tokens),
      kind: "usage",
      outputTokens: naturalOf(message.usage.output_tokens),
      rateLimitPct: null,
      rateLimitResetsAtMs: null,
      rateLimitStatus: null,
      rateLimitType: null,
      turns,
    },
    {
      costUsd,
      durationMs: naturalOf(message.duration_ms),
      errorClass: failure?.errorClass ?? null,
      errorMessage: failure?.errorMessage ?? null,
      kind: "result",
      outcome: failure?.outcome ?? "done",
      providerSessionId: message.session_id,
      text: message.subtype === "success" ? message.result : "",
      totalTokens: tokensOf(message.usage),
      turns,
    },
  ];
};

/** One SDK message as normalized events. Pure but for the cursor it advances. */
export const normalize = (
  cursor: Cursor,
  message: SDKMessage
): readonly AgentEvent[] => {
  const events = ((): readonly AgentEvent[] => {
    switch (message.type) {
      case "assistant":
        return assistantEvents(message);
      case "user":
        return toolResultEvents(message);
      case "result":
        cursor.terminated = true;
        return resultEvents(message);
      case "rate_limit_event":
        return rateLimitEvents(message);
      case "system":
        return systemEvents(cursor, message);
      default:
        return NO_EVENTS;
    }
  })();
  cursor.eventsSeen += events.length;
  return events;
};

/**
 * The terminus for a stream that ran out of messages without one.
 *
 * This is the failure a harness has to name itself. The SDK finished, nothing
 * threw, and the turn produced no ending — a run left like that looks healthy
 * from every angle except the one that matters, so it ends on a `result` of its
 * own carrying how far it got.
 */
export const terminusOf = (cursor: Cursor): readonly AgentEvent[] => {
  if (cursor.terminated) {
    return NO_EVENTS;
  }
  const failure = describeError(
    new NoTerminalEvent({ eventsSeen: cursor.eventsSeen })
  );
  return [
    {
      costUsd: null,
      durationMs: null,
      errorClass: failure.errorClass,
      errorMessage: failure.errorMessage,
      kind: "result",
      outcome: failure.outcome,
      providerSessionId: cursor.providerSessionId,
      text: "",
      totalTokens: null,
      turns: null,
    },
  ];
};
