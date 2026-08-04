/**
 * Every line of `codex exec --json` this harness understands, and the
 * normalized event it becomes.
 *
 * Codex speaks a thread-and-item protocol that grows with each release, and
 * almost none of it is something the orchestrator should have to know about —
 * item updates, a to-do list, the warning Codex prints about a flag we always
 * pass. This file is the whole of that knowledge, and it is pure: one line of
 * JSONL and the state before it go in, events and the state after come out, so
 * what a turn reports can be asserted from a fixture instead of from a live
 * model.
 *
 * Two rules shape what crosses over. Content is measured, never carried:
 * reasoning becomes a character count and a shell command becomes its first
 * line, shortened. And a number is reported only when Codex reported one —
 * which is why every cost here is null and never `0`. Codex bills a
 * subscription and names no per-run amount anywhere in its output.
 *
 * Nothing here decodes strictly. A line that is not JSON, or is a shape this
 * file does not read, changes nothing and produces nothing: a release that adds
 * an item type should cost a missing row in a timeline, not a dead run.
 */

import type { SessionProvider } from "@workspace/domain";
import { clipError } from "@workspace/telemetry";
import { Result, Schema } from "effect";
import { classify } from "./errors";
import type { AgentEvent } from "./events";

/** The provider these events are normalized from. */
export const PROVIDER_ID: SessionProvider = "codex";

/**
 * The flag that makes Codex run hooks it has no persisted trust record for.
 * Declared here rather than beside the other invocation flags because both
 * halves of it live here: it is passed on every invocation, and Codex answers
 * it with a warning that {@link stepCodexLine} has to recognize to drop.
 */
export const HOOK_TRUST_FLAG = "--dangerously-bypass-hook-trust";

/** Length past which a command line is elided in a tool summary. */
const SUMMARY_CHARS = 80;

/** Marks an elided summary, and costs its own length from the budget. */
const ELLIPSIS = "...";

/** A turn is one invocation, so a turn count is a constant here. */
const TURNS_PER_INVOCATION = 1;

/** The shell wrapper Codex puts around every command it runs. */
const SHELL_WRAPPER = /^\S*sh -l?c /;

/** Tokens Codex counts on a completed turn. Every key is absent on a failure. */
const CodexUsage = Schema.Struct({
  cached_input_tokens: Schema.optionalKey(Schema.Number),
  input_tokens: Schema.optionalKey(Schema.Number),
  output_tokens: Schema.optionalKey(Schema.Number),
  reasoning_output_tokens: Schema.optionalKey(Schema.Number),
});

/** A shell command Codex ran. `exit_code` is absent until it exits. */
const CommandExecution = Schema.Struct({
  aggregated_output: Schema.optionalKey(Schema.String),
  command: Schema.String,
  exit_code: Schema.optionalKey(Schema.NullOr(Schema.Number)),
  id: Schema.String,
  status: Schema.String,
  type: Schema.tag("command_execution"),
});

/** A patch Codex applied, reported once the whole patch succeeded or failed. */
const FileChange = Schema.Struct({
  changes: Schema.Array(
    Schema.Struct({ kind: Schema.String, path: Schema.String })
  ),
  id: Schema.String,
  status: Schema.String,
  type: Schema.tag("file_change"),
});

/** A call into an MCP server. */
const McpToolCall = Schema.Struct({
  arguments: Schema.optionalKey(Schema.Unknown),
  error: Schema.optionalKey(Schema.Struct({ message: Schema.String })),
  id: Schema.String,
  server: Schema.String,
  status: Schema.String,
  tool: Schema.String,
  type: Schema.tag("mcp_tool_call"),
});

/** A web search. Reported complete, with the query it ran. */
const WebSearch = Schema.Struct({
  id: Schema.String,
  query: Schema.String,
  type: Schema.tag("web_search"),
});

/** A complete assistant message. */
const AgentMessage = Schema.Struct({
  id: Schema.String,
  text: Schema.String,
  type: Schema.tag("agent_message"),
});

/** A reasoning summary. Its text is measured here and never carried. */
const ReasoningSummary = Schema.Struct({
  id: Schema.String,
  text: Schema.String,
  type: Schema.tag("reasoning"),
});

/** A non-fatal error Codex surfaced as an item rather than ending the turn on. */
const ErrorItem = Schema.Struct({
  id: Schema.String,
  message: Schema.String,
  type: Schema.tag("error"),
});

/**
 * The items this harness reads. Deliberately not every item Codex can emit:
 * a `todo_list` has no normalized event, and an item type added by a future
 * release fails this union and is skipped rather than crashing a live run.
 */
const CodexItem = Schema.Union([
  AgentMessage,
  CommandExecution,
  ErrorItem,
  FileChange,
  McpToolCall,
  ReasoningSummary,
  WebSearch,
]);

/**
 * One line of `codex exec --json`. `turn.started` and `item.updated` are absent
 * for the same reason as `todo_list`: they carry nothing the timeline wants, and
 * an unmatched line is already the ignore path.
 */
const CodexWireEvent = Schema.Union([
  Schema.Struct({
    thread_id: Schema.String,
    type: Schema.tag("thread.started"),
  }),
  Schema.Struct({
    type: Schema.tag("turn.completed"),
    usage: Schema.optionalKey(Schema.NullOr(CodexUsage)),
  }),
  Schema.Struct({
    error: Schema.Struct({ message: Schema.String }),
    type: Schema.tag("turn.failed"),
  }),
  Schema.Struct({ item: CodexItem, type: Schema.tag("item.started") }),
  Schema.Struct({ item: CodexItem, type: Schema.tag("item.completed") }),
  Schema.Struct({ message: Schema.String, type: Schema.tag("error") }),
]);

/** Decodes one line, or nothing. Total: bad JSON and unread shapes both yield none. */
const decodeWireEvent = Schema.decodeUnknownOption(
  Schema.fromJsonString(CodexWireEvent)
);
/** What a Codex item looks like once decoded. */
type CodexItem = typeof CodexItem.Type;

/**
 * Everything one turn accumulates across its lines. Held as a value rather than
 * a closure so the fold below stays pure and a fixture can start it anywhere.
 */
export interface CodexTurnState {
  /** Wire events understood so far. Tells a silent provider apart from a truncated one. */
  readonly eventsSeen: number;
  /** Why the turn ended badly, if it said. Set by `turn.failed` and the fatal `error` line. */
  readonly fatalMessage: string | null;
  /** The last complete assistant message: the turn's result text. */
  readonly lastAssistantText: string;
  /** Tool calls announced but not yet answered, so a result never arrives orphaned. */
  readonly openCallIds: ReadonlySet<string>;
  /** Codex's own id for this conversation, carried from the resume or from `thread.started`. */
  readonly providerSessionId: string | null;
  /** Monotonic start, for the turn's duration. */
  readonly startedAtMs: number;
  /** Whether the terminus was emitted. A false here at end of stream is the lost run. */
  readonly terminated: boolean;
}

/** What a turn starts from. */
export interface CodexTurnStart {
  /** The session being continued, or null for a fresh thread. */
  readonly providerSessionId: string | null;
  readonly startedAtMs: number;
}

/** The state a turn begins in. */
export const initialCodexTurnState = ({
  providerSessionId,
  startedAtMs,
}: CodexTurnStart): CodexTurnState => ({
  eventsSeen: 0,
  fatalMessage: null,
  lastAssistantText: "",
  openCallIds: new Set(),
  providerSessionId,
  startedAtMs,
  terminated: false,
});

/** One line of JSONL, the clock that saw it, and what came before. */
export interface CodexStepInput {
  readonly line: string;
  /** Read from the clock by the caller, so the fold itself has no time source. */
  readonly nowMs: number;
  readonly state: CodexTurnState;
}

/** What one line produced. */
export interface CodexStep {
  readonly events: readonly AgentEvent[];
  readonly state: CodexTurnState;
}

/** Strips the shell wrapper and shortens a command line for a summary. */
const summarizeCommand = (command: string) => {
  const unwrapped = command.replace(SHELL_WRAPPER, "");
  return unwrapped.length > SUMMARY_CHARS
    ? `${unwrapped.slice(0, SUMMARY_CHARS - ELLIPSIS.length)}${ELLIPSIS}`
    : unwrapped;
};

/**
 * Codex sometimes reports an upstream failure as a JSON document rather than a
 * sentence. The inner message is the part a human can act on; the envelope is
 * noise that would fill the whole clipped field.
 */
const innerMessage = (raw: string) => {
  const decoded = Result.getOrElse(
    Result.try({
      catch: () => null,
      try: () => JSON.parse(raw) as unknown,
    }),
    () => null
  );
  if (typeof decoded !== "object" || decoded === null) {
    return raw;
  }
  const record = decoded as { readonly error?: unknown; message?: unknown };
  const nested = (record.error as { readonly message?: unknown } | undefined)
    ?.message;
  if (typeof nested === "string") {
    return nested;
  }
  return typeof record.message === "string" ? record.message : raw;
};

/**
 * The token total Codex reports. Null rather than zero when it reported none:
 * a turn that failed before the first request really did use no tokens, and a
 * turn whose usage was dropped did not, and an average over both is wrong.
 */
const sumUsage = (usage: typeof CodexUsage.Type | null | undefined) => {
  if (!usage) {
    return null;
  }
  const counted = [
    usage.input_tokens,
    usage.cached_input_tokens,
    usage.output_tokens,
    usage.reasoning_output_tokens,
  ].filter((value): value is number => typeof value === "number");
  return counted.length === 0
    ? null
    : counted.reduce((total, value) => total + value, 0);
};

/** A non-negative count, so a clock that went backwards cannot produce a negative duration. */
const nonNegative = (value: number) => (value < 0 ? 0 : Math.trunc(value));

/** The invoking half of a tool item, or null for an item that is not a tool. */
const toolCallOf = (item: CodexItem) => {
  switch (item.type) {
    case "command_execution":
      return {
        inputChars: item.command.length,
        summary: clipError(summarizeCommand(item.command)),
        toolName: "shell",
      };
    case "file_change": {
      const paths = item.changes.map((change) => change.path).join(" ");
      return {
        inputChars: paths.length,
        summary: clipError(paths),
        toolName: "apply_patch",
      };
    }
    case "mcp_tool_call": {
      const encoded = JSON.stringify(item.arguments ?? null);
      return {
        inputChars: encoded.length,
        summary: clipError(item.server),
        // Namespaced by server: two servers exposing `search` are two tools.
        toolName: `${item.server}/${item.tool}`,
      };
    }
    case "web_search":
      return {
        inputChars: item.query.length,
        summary: clipError(item.query),
        toolName: "web_search",
      };
    default:
      return null;
  }
};

/** The answering half of a tool item, or null for an item that is not a tool. */
const toolResultOf = (item: CodexItem) => {
  switch (item.type) {
    case "command_execution": {
      const output = item.aggregated_output ?? "";
      return {
        ok: item.exit_code === 0,
        outputChars: output.length,
        summary: clipError(output),
      };
    }
    case "file_change":
      return {
        ok: item.status === "completed",
        outputChars: 0,
        summary: `${item.changes.length} file(s)`,
      };
    case "mcp_tool_call": {
      const failure = item.error?.message ?? "";
      return {
        ok: item.status === "completed",
        outputChars: failure.length,
        summary: clipError(failure),
      };
    }
    case "web_search":
      return { ok: true, outputChars: 0, summary: "" };
    default:
      return null;
  }
};

/** Nothing happened on this line. */
const unchanged = (state: CodexTurnState): CodexStep => ({ events: [], state });

/** A recovered error, named by the shared classifier and sanitized once. */
const errorEventOf = (message: string): AgentEvent => ({
  errorClass: classify({ thrown: message }),
  errorMessage: clipError(innerMessage(message)),
  kind: "error",
});

/**
 * A tool item's events. Codex announces a tool on `item.started` and answers it
 * on `item.completed`, but a patch is only reported once it has already been
 * applied — so a completion for a call never announced synthesizes the call
 * first, and the pair is never half-written.
 */
const stepToolItem = (
  item: CodexItem,
  completed: boolean,
  state: CodexTurnState
): CodexStep => {
  const call = toolCallOf(item);
  if (call === null) {
    return unchanged(state);
  }
  const announced = state.openCallIds.has(item.id);
  const opening: readonly AgentEvent[] = announced
    ? []
    : [{ callId: item.id, kind: "tool_call", ...call }];
  if (!completed) {
    return {
      events: opening,
      state: { ...state, openCallIds: new Set(state.openCallIds).add(item.id) },
    };
  }
  const result = toolResultOf(item);
  const closing: readonly AgentEvent[] =
    result === null
      ? []
      : [{ callId: item.id, kind: "tool_result", ...result }];
  const remaining = new Set(state.openCallIds);
  remaining.delete(item.id);
  return {
    events: [...opening, ...closing],
    state: { ...state, openCallIds: remaining },
  };
};

/** One thread item's events. Only completions speak, apart from a tool's opening. */
const stepItem = (
  item: CodexItem,
  completed: boolean,
  state: CodexTurnState
): CodexStep => {
  switch (item.type) {
    case "agent_message":
      return completed
        ? {
            events: [{ kind: "assistant_text", text: item.text }],
            state: { ...state, lastAssistantText: item.text },
          }
        : unchanged(state);
    case "reasoning":
      return completed && item.text.length > 0
        ? {
            events: [
              { chars: item.text.length, durationMs: null, kind: "reasoning" },
            ],
            state,
          }
        : unchanged(state);
    case "error":
      // An error item is Codex recovering, not Codex stopping: the turn's own
      // failure arrives as `turn.failed` and is handled where the stream ends.
      return completed && !item.message.includes(HOOK_TRUST_FLAG)
        ? { events: [errorEventOf(item.message)], state }
        : unchanged(state);
    default:
      return stepToolItem(item, completed, state);
  }
};

/**
 * The terminus, plus the token reading that would otherwise be lost: the result
 * carries a total, and the usage event carries the split, which is the only
 * place the input/output ratio of a turn survives.
 */
const stepTurnCompleted = (
  usage: typeof CodexUsage.Type | null | undefined,
  nowMs: number,
  state: CodexTurnState
): CodexStep => {
  const totalTokens = sumUsage(usage);
  return {
    events: [
      {
        costUsd: null,
        inputTokens: usage?.input_tokens ?? null,
        kind: "usage",
        outputTokens: usage?.output_tokens ?? null,
        rateLimitPct: null,
        rateLimitResetsAtMs: null,
        rateLimitStatus: null,
        rateLimitType: null,
        turns: TURNS_PER_INVOCATION,
      },
      {
        costUsd: null,
        durationMs: nonNegative(nowMs - state.startedAtMs),
        errorClass: null,
        errorMessage: null,
        kind: "result",
        outcome: "done",
        providerSessionId: state.providerSessionId,
        text: state.lastAssistantText,
        totalTokens,
        turns: TURNS_PER_INVOCATION,
      },
    ],
    state: { ...state, terminated: true },
  };
};

/**
 * Folds one line of `codex exec --json` into normalized events. Pure and total:
 * a line that is not JSON, or is a shape this harness does not read, changes
 * nothing and produces nothing.
 *
 * `turn.failed` produces no event of its own. A turn that failed has no
 * terminus, and the stream carries that as a typed failure rather than as an
 * event a reader could mistake for a recovered error — so all it does here is
 * record what to fail with.
 */
export const stepCodexLine = ({
  line,
  nowMs,
  state,
}: CodexStepInput): CodexStep => {
  const trimmed = line.trim();
  if (trimmed.length === 0) {
    return unchanged(state);
  }
  const decoded = decodeWireEvent(trimmed);
  if (decoded._tag === "None") {
    return unchanged(state);
  }
  const event = decoded.value;
  const seen: CodexTurnState = { ...state, eventsSeen: state.eventsSeen + 1 };
  switch (event.type) {
    case "thread.started":
      return {
        events: [
          {
            // Codex never names the model it chose, and guessing it from what
            // was asked for would put a value in the ledger nothing verified.
            kind: "session_init",
            model: null,
            provider: PROVIDER_ID,
            providerSessionId: event.thread_id,
          },
        ],
        state: { ...seen, providerSessionId: event.thread_id },
      };
    case "item.started":
      return stepItem(event.item, false, seen);
    case "item.completed":
      return stepItem(event.item, true, seen);
    case "turn.completed":
      return stepTurnCompleted(event.usage, nowMs, seen);
    case "turn.failed":
      return unchanged({
        ...seen,
        fatalMessage: innerMessage(event.error.message),
      });
    default:
      // A stream-level error is not always the end: Codex reports each attempt
      // of a reconnect this way and then goes on to finish the turn. So it is
      // both a visible error and the standing answer to "why did this stop",
      // which is read only if no terminus ever arrives.
      return {
        events: [errorEventOf(event.message)],
        state: { ...seen, fatalMessage: innerMessage(event.message) },
      };
  }
};
