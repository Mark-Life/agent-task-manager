/**
 * Every line of `pi --mode json` this harness understands, and the normalized
 * event it becomes.
 *
 * Pi speaks an agent/turn/message protocol with a delta for every token, and
 * almost none of that is something the orchestrator should see: a paragraph
 * arrives as forty `message_update` lines carrying one character each, and a
 * row per delta is a hundred thousand rows in Postgres to render the same
 * paragraph. So the deltas are dropped and the authoritative `message_end` is
 * read instead, which is the same message with nothing left to accumulate. The
 * whole of that knowledge is here, and it is pure: one line of JSONL and the
 * state before it go in, events and the state after come out.
 *
 * **Pi exits zero on a turn that failed.** A refused key, an unreachable
 * endpoint, three exhausted retries — all of them end with `agent_settled` and
 * status 0, and the only account of what went wrong is `stopReason: "error"`
 * with an `errorMessage` on the last assistant message. So this file, and not
 * the exit code, is what decides a Pi turn's outcome; `./pi.ts` reads the exit
 * code only for the case where the stream stopped before saying anything.
 *
 * Three rules shape what crosses over. Content is measured, never carried:
 * thinking becomes a character count, and a tool's arguments become the label
 * `./tool-summary` allows. Numbers are reported only where Pi reported them —
 * but unlike the other two providers, Pi reports money, because it runs on the
 * operator's own API key and prices every request from its own model catalog.
 * And the session id is announced as early as it is known, because it is the
 * only address this run's transcript has.
 *
 * Nothing here decodes strictly. A line that is not JSON, or is a shape this
 * file does not read — `queue_update`, a compaction, whatever the next release
 * adds — changes nothing and produces nothing.
 */

import type { SessionProvider } from "@workspace/domain";
import { clipError } from "@workspace/telemetry";
import { Schema } from "effect";
import { classify } from "./errors";
import { type AgentEvent, costUsdOf } from "./events";
import { commandLabel, isRecord, stringOf } from "./tool-summary";

/** The provider these events are normalized from. */
export const PROVIDER_ID: SessionProvider = "pi";

/**
 * Which field of a built-in Pi tool's arguments reads as its summary.
 *
 * The same allow-list rule as Claude's, for the same reason: an unknown tool's
 * arguments are an unknown shape, and guessing at one is how a credential ends
 * up on the timeline. These eight are Pi's whole built-in table — `read`,
 * `bash`, `powershell`, `edit`, `write`, `grep`, `find`, `ls` — and everything
 * else a turn can call is an extension's, including the board tools, which
 * summarize as nothing.
 *
 * `bash` and `powershell` are absent because a command line is not a field to
 * be copied; they go through {@link commandLabel} below.
 */
const TOOL_SUMMARY_FIELD: Readonly<Record<string, string>> = {
  edit: "path",
  find: "pattern",
  grep: "pattern",
  ls: "path",
  read: "path",
  write: "path",
};

/** The two tools whose argument is a command line rather than a value. */
const SHELL_TOOLS: ReadonlySet<string> = new Set(["bash", "powershell"]);

/** How Pi says a turn ended badly, on the message rather than on the process. */
const ERROR_STOP_REASON = "error";

/** How Pi says a turn was cancelled from outside. */
const ABORTED_STOP_REASON = "aborted";

/** A count of tokens or characters Pi reported, or null where it reported none. */
const NumberOrNull = Schema.optionalKey(Schema.NullOr(Schema.Number));

/**
 * What one request cost and consumed, as Pi reports it on every assistant
 * message.
 *
 * `cost` is Pi's own arithmetic over its model catalog, not ours: it holds the
 * per-million rates for every model it can reach, including the ones an
 * operator adds in `models.json`, and a `models.json` entry that names no cost
 * simply prices at zero. That makes this the one provider whose dollar figure
 * arrives with the run instead of being derived afterwards from
 * `@workspace/domain`'s price table.
 */
const PiUsage = Schema.Struct({
  cost: Schema.optionalKey(
    Schema.NullOr(Schema.Struct({ total: NumberOrNull }))
  ),
  input: NumberOrNull,
  output: NumberOrNull,
  totalTokens: NumberOrNull,
});

/**
 * One block of a message's content. Only the three that carry something a
 * timeline wants are named; an image or a block a later release adds decodes as
 * none of these and contributes nothing.
 */
const PiContentBlock = Schema.Union([
  Schema.Struct({ text: Schema.String, type: Schema.tag("text") }),
  Schema.Struct({ thinking: Schema.String, type: Schema.tag("thinking") }),
  Schema.Struct({
    id: Schema.String,
    name: Schema.String,
    type: Schema.tag("toolCall"),
  }),
]);

/**
 * A message as Pi writes it, at the point it is complete.
 *
 * `content` is optional and loosely typed because a failed assistant message
 * carries an empty array and a user message carries a bare string; the blocks
 * that matter are picked out below rather than required here, so one shape a
 * release changes cannot cost the turn its terminus.
 */
const PiMessage = Schema.Struct({
  content: Schema.optionalKey(Schema.Unknown),
  errorMessage: Schema.optionalKey(Schema.NullOr(Schema.String)),
  model: Schema.optionalKey(Schema.NullOr(Schema.String)),
  role: Schema.String,
  stopReason: Schema.optionalKey(Schema.NullOr(Schema.String)),
  usage: Schema.optionalKey(Schema.NullOr(PiUsage)),
});

/**
 * One line of `pi --mode json`.
 *
 * `message_update` is deliberately absent: it is the per-token delta, it is
 * most of the file by volume, and every field on it is superseded by the
 * `message_end` that follows. `agent_start`, `turn_start` and the queue and
 * compaction lines are absent for the milder reason that they carry nothing a
 * timeline wants.
 */
const PiWireEvent = Schema.Union([
  Schema.Struct({ id: Schema.String, type: Schema.tag("session") }),
  Schema.Struct({ message: PiMessage, type: Schema.tag("message_start") }),
  Schema.Struct({ message: PiMessage, type: Schema.tag("message_end") }),
  Schema.Struct({ type: Schema.tag("turn_end") }),
  Schema.Struct({
    args: Schema.optionalKey(Schema.Unknown),
    toolCallId: Schema.String,
    toolName: Schema.String,
    type: Schema.tag("tool_execution_start"),
  }),
  Schema.Struct({
    isError: Schema.optionalKey(Schema.NullOr(Schema.Boolean)),
    result: Schema.optionalKey(Schema.Unknown),
    toolCallId: Schema.String,
    toolName: Schema.String,
    type: Schema.tag("tool_execution_end"),
  }),
  Schema.Struct({
    attempt: Schema.Number,
    errorMessage: Schema.optionalKey(Schema.NullOr(Schema.String)),
    maxAttempts: Schema.Number,
    type: Schema.tag("auto_retry_start"),
  }),
  Schema.Struct({ type: Schema.tag("agent_settled") }),
]);

/** Decodes one line, or nothing. Total: bad JSON and unread shapes both yield none. */
const decodeWireEvent = Schema.decodeUnknownOption(
  Schema.fromJsonString(PiWireEvent)
);

/** Decodes one content block, or nothing. */
const decodeContentBlock = Schema.decodeUnknownOption(PiContentBlock);

type PiMessage = typeof PiMessage.Type;
type PiUsage = typeof PiUsage.Type;

/**
 * Everything one invocation accumulates across its lines. Held as a value
 * rather than a closure so the fold below stays pure and a fixture can start it
 * anywhere.
 */
export interface PiTurnState {
  /** Dollars Pi has priced so far, summed over requests. Null until one reported. */
  readonly costUsd: number | null;
  /** Wire events understood so far. Tells a silent provider apart from a truncated one. */
  readonly eventsSeen: number;
  /** The last assistant message's `errorMessage`, which is Pi's whole account of a failed turn. */
  readonly fatalMessage: string | null;
  /** The last complete assistant message: the turn's result text. */
  readonly lastAssistantText: string;
  /** What actually answered, off the first assistant message. Null until one arrives. */
  readonly model: string | null;
  /** Tool calls announced but not yet answered, so a result never arrives orphaned. */
  readonly openCallIds: ReadonlySet<string>;
  /** Pi's own id for this conversation, from the session header or from the resume. */
  readonly providerSessionId: string | null;
  /** Whether `session_init` has been emitted; see {@link stepPiLine}. */
  readonly sessionAnnounced: boolean;
  /** Monotonic start, for the turn's duration. */
  readonly startedAtMs: number;
  /** How the last assistant message ended, which is what picks the outcome. */
  readonly stopReason: string | null;
  /** Whether the terminus was emitted. A false here at end of stream is the lost run. */
  readonly terminated: boolean;
  /** Tokens Pi counted, summed over requests. Null until one reported. */
  readonly totalTokens: number | null;
}

/** What an invocation starts from. */
export interface PiTurnStart {
  /** The session being continued, or null for a fresh one. */
  readonly providerSessionId: string | null;
  readonly startedAtMs: number;
}

/** The state an invocation begins in. */
export const initialPiTurnState = ({
  providerSessionId,
  startedAtMs,
}: PiTurnStart): PiTurnState => ({
  costUsd: null,
  eventsSeen: 0,
  fatalMessage: null,
  lastAssistantText: "",
  model: null,
  openCallIds: new Set(),
  providerSessionId,
  sessionAnnounced: false,
  startedAtMs,
  stopReason: null,
  terminated: false,
  totalTokens: null,
});

/** One line of JSONL, the clock that saw it, and what came before. */
export interface PiStepInput {
  readonly line: string;
  /** Read from the clock by the caller, so the fold itself has no time source. */
  readonly nowMs: number;
  readonly state: PiTurnState;
}

/** What one line produced. */
export interface PiStep {
  readonly events: readonly AgentEvent[];
  readonly state: PiTurnState;
}

/** Nothing happened on this line. */
const unchanged = (state: PiTurnState): PiStep => ({ events: [], state });

/** A non-negative count, so a clock that went backwards cannot produce a negative duration. */
const nonNegative = (value: number) => (value < 0 ? 0 : Math.trunc(value));

/**
 * Two readings added, where either may be absent.
 *
 * Null plus a number is the number, and null plus null is null — which is the
 * whole point: a turn that reported nothing has to stay unreported rather than
 * become a zero somebody later averages.
 */
const add = (left: number | null, right: number | null | undefined) => {
  if (typeof right !== "number" || !Number.isFinite(right)) {
    return left;
  }
  return left === null ? right : left + right;
};

/** A count Pi reported, or null. Refuses a negative or a fraction rather than clamping it. */
const countOf = (value: number | null | undefined) =>
  typeof value === "number" && Number.isInteger(value) && value >= 0
    ? value
    : null;

/** The decoded content blocks of a message, in order. Unreadable ones are skipped. */
const blocksOf = (message: PiMessage) => {
  const { content } = message;
  if (!Array.isArray(content)) {
    return [];
  }
  return content.flatMap((raw) => {
    const decoded = decodeContentBlock(raw);
    return decoded._tag === "Some" ? [decoded.value] : [];
  });
};

/**
 * The short description of a tool call a reader wants, and nothing more.
 *
 * A shell command is reduced to its verb and everything else is read from the
 * allow-list; a tool this file has never heard of summarizes as the empty
 * string. The board tools land in that last case deliberately — their arguments
 * are a task id and often a message body, and neither belongs on a row that is
 * kept forever.
 */
const toolSummary = (name: string, args: unknown) => {
  if (!isRecord(args)) {
    return "";
  }
  if (SHELL_TOOLS.has(name)) {
    return commandLabel(stringOf(args.command));
  }
  const field = TOOL_SUMMARY_FIELD[name];
  return field === undefined ? "" : clipError(stringOf(args[field]));
};

/**
 * The text of a tool result, which Pi writes as content blocks even for the
 * tools that only ever return a line. Non-text blocks contribute nothing: an
 * image is not something a row can carry, and a placeholder for it would be
 * counted as content.
 */
const resultText = (result: unknown) => {
  if (!isRecord(result)) {
    return "";
  }
  const { content } = result;
  if (!Array.isArray(content)) {
    return "";
  }
  return content
    .map((block) => (isRecord(block) ? stringOf(block.text) : ""))
    .filter((text) => text.length > 0)
    .join("\n");
};

/**
 * The usage event one assistant message produces, or none where Pi reported no
 * numbers at all.
 *
 * Pi names no rate-limit window anywhere in its output, so those four fields are
 * null on every reading — a Pi run finds out it is limited by being refused,
 * exactly as a Codex one does.
 */
const usageEventOf = (usage: PiUsage): AgentEvent | null => {
  const inputTokens = countOf(usage.input);
  const outputTokens = countOf(usage.output);
  const costUsd = costUsdOf(usage.cost?.total);
  if (inputTokens === null && outputTokens === null && costUsd === null) {
    return null;
  }
  return {
    costUsd,
    inputTokens,
    kind: "usage",
    outputTokens,
    rateLimitPct: null,
    rateLimitResetsAtMs: null,
    rateLimitStatus: null,
    rateLimitType: null,
    turns: null,
  };
};

/**
 * `session_init`, once.
 *
 * Held back from the session header line and emitted at the first assistant
 * message, which is where Pi first names the model that answered — the header
 * carries the id and nothing else, and "the provider chose a model and we did
 * not write it down" is a worse row than one event's delay. Nothing is
 * normalized from the lines in between, so in practice this is still the first
 * event of the turn.
 *
 * The delay is bounded by {@link stepPiLine}'s terminus, which announces the
 * session with a null model if no assistant message ever arrived. A turn that
 * ends without this event ends without an address for its transcript, and that
 * is the one thing this stream must not lose.
 */
const announceSession = (state: PiTurnState): readonly AgentEvent[] =>
  state.sessionAnnounced || state.providerSessionId === null
    ? []
    : [
        {
          kind: "session_init",
          model: state.model,
          provider: PROVIDER_ID,
          providerSessionId: state.providerSessionId,
        },
      ];

/**
 * A complete assistant message: what it said, what it thought, and what it
 * cost.
 *
 * Thinking is measured and never quoted, here as everywhere else. The count is
 * the total across every thinking block on the message, so a turn that thought
 * in four passes is one reasoning event of their combined size rather than four
 * events a reader has to add up.
 */
const stepAssistantMessage = (
  message: PiMessage,
  state: PiTurnState
): PiStep => {
  const blocks = blocksOf(message);
  const text = blocks
    .filter((block) => block.type === "text")
    .map((block) => block.text)
    .join("");
  const thoughtChars = blocks
    .filter((block) => block.type === "thinking")
    .reduce((total, block) => total + block.thinking.length, 0);
  const usage = message.usage ?? null;
  const usageEvent = usage === null ? null : usageEventOf(usage);

  // The model this message names is learned before the session is announced,
  // not after: this is the line that knows it, and announcing first would put a
  // null on the one event that carries it.
  const model = state.model ?? message.model ?? null;
  const announced = announceSession({ ...state, model });
  return {
    events: [
      ...announced,
      ...(text.length > 0
        ? [{ kind: "assistant_text", text } as const satisfies AgentEvent]
        : []),
      ...(thoughtChars > 0
        ? [
            {
              chars: thoughtChars,
              durationMs: null,
              kind: "reasoning",
            } as const satisfies AgentEvent,
          ]
        : []),
      ...(usageEvent === null ? [] : [usageEvent]),
    ],
    state: {
      ...state,
      costUsd: add(state.costUsd, usage?.cost?.total),
      fatalMessage: message.errorMessage ?? state.fatalMessage,
      lastAssistantText: text.length > 0 ? text : state.lastAssistantText,
      model,
      sessionAnnounced: state.sessionAnnounced || announced.length > 0,
      stopReason: message.stopReason ?? state.stopReason,
      totalTokens: add(state.totalTokens, usage?.totalTokens),
    },
  };
};

/**
 * How the turn ended, read off the last assistant message.
 *
 * `aborted` is Pi's word for a turn something outside it cancelled, which is
 * the interrupt; `error` is a request that failed and, if it was retryable, had
 * already failed its last retry by the time the stream settled. Everything else
 * — `stop`, `toolUse`, `length` — is a turn that ran.
 */
const outcomeOf = (state: PiTurnState) => {
  if (state.stopReason === ABORTED_STOP_REASON) {
    return "interrupted" as const;
  }
  return state.stopReason === ERROR_STOP_REASON
    ? ("errored" as const)
    : ("done" as const);
};

/**
 * The terminus, which every Pi invocation reaches — including the failed ones.
 *
 * Pi settles rather than exiting non-zero, so this is where a failure is turned
 * into an outcome and a class. The economics are carried on every outcome,
 * unlike the other two harnesses: a turn that failed on its third retry still
 * spent money on the first two, and dropping that is how a bill stops matching
 * the ledger.
 */
const stepSettled = (nowMs: number, state: PiTurnState): PiStep => {
  const outcome = outcomeOf(state);
  const announced = announceSession(state);
  return {
    events: [
      ...announced,
      {
        costUsd: costUsdOf(state.costUsd),
        durationMs: nonNegative(nowMs - state.startedAtMs),
        errorClass:
          outcome === "done"
            ? null
            : classify({ thrown: state.fatalMessage ?? outcome }),
        errorMessage:
          outcome === "done" || state.fatalMessage === null
            ? null
            : clipError(state.fatalMessage),
        kind: "result",
        outcome,
        providerSessionId: state.providerSessionId,
        text: state.lastAssistantText,
        totalTokens: state.totalTokens,
        // Pi runs one agent loop per invocation and counts its own turns inside
        // it; what the ledger calls a turn is this whole invocation.
        turns: null,
      },
    ],
    state: {
      ...state,
      sessionAnnounced: state.sessionAnnounced || announced.length > 0,
      terminated: true,
    },
  };
};

/** A recovered error, named by the shared classifier and sanitized once. */
const errorEventOf = (message: string): AgentEvent => ({
  errorClass: classify({ thrown: message }),
  errorMessage: clipError(message),
  kind: "error",
});

/**
 * Folds one line of `pi --mode json` into normalized events. Pure and total: a
 * line that is not JSON, or is a shape this harness does not read, changes
 * nothing and produces nothing.
 */
export const stepPiLine = ({ line, nowMs, state }: PiStepInput): PiStep => {
  const trimmed = line.trim();
  if (trimmed.length === 0) {
    return unchanged(state);
  }
  const decoded = decodeWireEvent(trimmed);
  if (decoded._tag === "None") {
    return unchanged(state);
  }
  const event = decoded.value;
  const seen: PiTurnState = { ...state, eventsSeen: state.eventsSeen + 1 };
  switch (event.type) {
    case "session":
      // The id and nothing else. A resume prints the header of the session it
      // reopened, so this agrees with what the caller asked to continue.
      return unchanged({ ...seen, providerSessionId: event.id });
    case "message_start":
      // Read for the model alone: Pi names it here before any content exists,
      // which is what lets `session_init` carry a real one.
      return unchanged(
        event.message.role === "assistant"
          ? { ...seen, model: seen.model ?? event.message.model ?? null }
          : seen
      );
    case "message_end":
      return event.message.role === "assistant"
        ? stepAssistantMessage(event.message, seen)
        : unchanged(seen);
    case "tool_execution_start": {
      const encoded = JSON.stringify(event.args ?? null);
      return {
        events: [
          {
            callId: event.toolCallId,
            inputChars: encoded.length,
            kind: "tool_call",
            summary: toolSummary(event.toolName, event.args),
            toolName: event.toolName,
          },
        ],
        state: {
          ...seen,
          openCallIds: new Set(seen.openCallIds).add(event.toolCallId),
        },
      };
    }
    case "tool_execution_end": {
      const text = resultText(event.result);
      const remaining = new Set(seen.openCallIds);
      remaining.delete(event.toolCallId);
      return {
        events: [
          {
            callId: event.toolCallId,
            kind: "tool_result",
            ok: event.isError !== true,
            outputChars: text.length,
            summary: clipError(text),
          },
        ],
        state: { ...seen, openCallIds: remaining },
      };
    }
    case "auto_retry_start":
      // Pi retrying is Pi recovering, not Pi stopping: the turn's own failure is
      // decided at `agent_settled` from the last message it managed to write.
      return {
        events: [
          errorEventOf(
            event.errorMessage ??
              `retrying (${event.attempt}/${event.maxAttempts})`
          ),
        ],
        state: seen,
      };
    case "turn_end":
      return unchanged(seen);
    default:
      return stepSettled(nowMs, seen);
  }
};
