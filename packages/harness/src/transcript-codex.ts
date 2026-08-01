/**
 * Reading Codex's transcript: one `rollout-<stamp>-<session>.jsonl` per
 * session, nested year/month/day under `CODEX_HOME/sessions`.
 *
 * Every line is `{ type, timestamp, payload }`, and Codex records the same
 * conversation twice. `response_item` lines are the API-level exchange —
 * messages, reasoning, tool calls and their outputs, in the order the model saw
 * them. `event_msg` lines are what its UI rendered: the same prose, minus the
 * injected context, plus token counts and turn markers.
 *
 * The API stream wins wherever it exists, because it is the only one of the two
 * that carries tool traffic and the developer prompt, and reading both would
 * double every assistant message. The UI stream is the fallback for a file
 * recorded in a mode that has no `response_item` lines at all — which is a
 * setting, not an error, and produces a thinner transcript rather than none.
 *
 * Reasoning is a special case in the other direction: Codex encrypts it and
 * ships a plaintext summary beside the ciphertext. Neither is quoted here. The
 * count measures the summary the provider chose to expose, so a turn that
 * exposed nothing counts zero — the ciphertext's length is not the thinking's.
 *
 * Pure and total, like its Claude counterpart: an unknown item type is skipped
 * rather than guessed at, and a line truncated by a killed process is dropped.
 */

import type { Transcript, TranscriptEntry, TranscriptRole } from "./transcript";

/** A line or a payload, once it is known to be an object. Every field is read defensively. */
type Line = Readonly<Record<string, unknown>>;

/** Whether a parsed JSON value is a plain object, which every line and payload is. */
const isRecord = (value: unknown): value is Line =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/** A nested object field, or null when it is absent or of another shape. */
const asRecord = (value: unknown) => (isRecord(value) ? value : null);

/** A string field, or null when absent or of another type. */
const stringOf = (value: unknown) => (typeof value === "string" ? value : null);

/** A number field, or null when absent or of another type. */
const numberOf = (value: unknown) =>
  typeof value === "number" && Number.isFinite(value) ? value : null;

/** One line of JSONL, or null when it is malformed or truncated mid-write. */
const parseLine = (line: string) => {
  try {
    return asRecord(JSON.parse(line));
  } catch {
    return null;
  }
};

/** What a draft entry leaves to the defaults. */
interface EntryDraft {
  readonly callId?: string;
  /** Set only where it is not `text.length` — that is, on reasoning. */
  readonly chars?: number;
  readonly ok?: boolean | null;
  readonly role: TranscriptRole;
  readonly text: string;
  readonly toolName?: string;
}

/** Completes a draft with the fields every entry carries. */
const toEntry = (
  draft: EntryDraft,
  line: number,
  occurredAt: string | null
): TranscriptEntry => ({
  callId: draft.callId ?? null,
  chars: draft.chars ?? draft.text.length,
  line,
  occurredAt,
  ok: draft.ok ?? null,
  role: draft.role,
  text: draft.text,
  toolName: draft.toolName ?? null,
});

/**
 * Whatever a field holds, as text. Codex writes tool payloads as a bare string
 * in the current format and as `{ content, metadata }` in the older one, so the
 * wrapper is unwrapped where it appears and serialized where it is something
 * else — a search's result list, an action object.
 */
const textOf = (value: unknown): string => {
  if (value === undefined || value === null) {
    return "";
  }
  const direct = stringOf(value);
  if (direct !== null) {
    return direct;
  }
  const content = stringOf(asRecord(value)?.content);
  return content ?? JSON.stringify(value);
};

/**
 * The tool-calling item types, the field each keeps its arguments in, and the
 * name to use when the item carries none. The built-in searches are items
 * rather than functions and have no `name` of their own, so one is supplied
 * here — a nameless tool call in the timeline is unreadable.
 */
const TOOL_CALLS = {
  custom_tool_call: { argumentsField: "input", fallbackName: "custom_tool" },
  function_call: { argumentsField: "arguments", fallbackName: "function" },
  tool_search_call: {
    argumentsField: "arguments",
    fallbackName: "tool_search",
  },
  web_search_call: { argumentsField: "action", fallbackName: "web_search" },
} as const;

/** The result item types, and the field each keeps its output in. */
const TOOL_RESULTS = {
  custom_tool_call_output: "output",
  function_call_output: "output",
  tool_search_output: "tools",
} as const;

/** Which transcript role a `message` item's own role becomes. */
const ROLE_OF_MESSAGE = {
  assistant: "assistant",
  developer: "system",
  system: "system",
  user: "user",
} as const satisfies Record<string, TranscriptRole>;

/**
 * Membership tests that narrow, so the lookups below read a key the compiler
 * agrees exists. `in` alone does not narrow a `string`, and the alternative is
 * a cast on every lookup — which is how a renamed key becomes a runtime
 * `undefined` instead of a build error.
 */
const isToolCall = (type: string): type is keyof typeof TOOL_CALLS =>
  type in TOOL_CALLS;

const isToolResult = (type: string): type is keyof typeof TOOL_RESULTS =>
  type in TOOL_RESULTS;

const isMessageRole = (role: string): role is keyof typeof ROLE_OF_MESSAGE =>
  role in ROLE_OF_MESSAGE;

/**
 * Whether a tool call succeeded. An exit code is believed over a status,
 * because the status describes the tool call — a shell command that exited 2
 * still `completed` — and only the code describes the command. Where the
 * payload carries neither, the answer is null rather than an optimistic true.
 */
const okOf = (payload: Line): boolean | null => {
  const metadata = asRecord(asRecord(payload.output)?.metadata);
  const exitCode = metadata === null ? null : numberOf(metadata.exit_code);
  if (exitCode !== null) {
    return exitCode === 0;
  }
  return stringOf(payload.status) === "failed" ? false : null;
};

/** A `message` item: several content parts, joined, under one role. */
const draftOfMessage = (payload: Line): EntryDraft | null => {
  const role = stringOf(payload.role) ?? "";
  if (!isMessageRole(role)) {
    return null;
  }
  const parts = Array.isArray(payload.content) ? payload.content : [];
  return {
    role: ROLE_OF_MESSAGE[role],
    text: parts
      .map((part) => stringOf(asRecord(part)?.text) ?? "")
      .filter((text) => text.length > 0)
      .join("\n"),
  };
};

/** A `reasoning` item, measured by the summary it exposed and never quoted. */
const draftOfReasoning = (payload: Line): EntryDraft => {
  const summary = Array.isArray(payload.summary) ? payload.summary : [];
  return {
    chars: summary.reduce<number>(
      (total, part) => total + (stringOf(asRecord(part)?.text) ?? "").length,
      0
    ),
    role: "reasoning",
    text: "",
  };
};

/** One `response_item` payload, as a draft entry, or null for a type not listed above. */
const draftOfItem = (payload: Line): EntryDraft | null => {
  const type = stringOf(payload.type) ?? "";
  if (type === "message") {
    return draftOfMessage(payload);
  }
  if (type === "reasoning") {
    return draftOfReasoning(payload);
  }
  if (isToolCall(type)) {
    const shape = TOOL_CALLS[type];
    return {
      callId: stringOf(payload.call_id) ?? stringOf(payload.id) ?? "",
      role: "tool_call",
      text: textOf(payload[shape.argumentsField]),
      toolName: stringOf(payload.name) ?? shape.fallbackName,
    };
  }
  if (isToolResult(type)) {
    const field = TOOL_RESULTS[type];
    return {
      callId: stringOf(payload.call_id) ?? "",
      ok: okOf(payload),
      role: "tool_result",
      text: textOf(payload[field]),
    };
  }
  return null;
};

/**
 * One `event_msg` payload, as a draft entry. Only the three that carry
 * conversation: token counts and turn markers are economics, and economics
 * reach the database as run events rather than as transcript lines.
 */
const draftOfEvent = (payload: Line): EntryDraft | null => {
  switch (stringOf(payload.type)) {
    case "agent_message":
      return { role: "assistant", text: stringOf(payload.message) ?? "" };
    case "agent_reasoning":
      return {
        chars: (stringOf(payload.text) ?? "").length,
        role: "reasoning",
        text: "",
      };
    case "user_message":
      return { role: "user", text: stringOf(payload.message) ?? "" };
    default:
      return null;
  }
};

/** Applies one of the two readers to a line, given the line type it reads. */
const entriesOf = (
  record: Line,
  line: number,
  lineType: string,
  draftOf: (payload: Line) => EntryDraft | null
): readonly TranscriptEntry[] => {
  if (stringOf(record.type) !== lineType) {
    return [];
  }
  const payload = asRecord(record.payload);
  const draft = payload === null ? null : draftOf(payload);
  return draft === null
    ? []
    : [toEntry(draft, line, stringOf(record.timestamp))];
};

/** The session id, which the `session_meta` line declares under either of two names. */
const sessionIdOf = (records: readonly (Line | null)[]) =>
  records.reduce<string | null>((found, record) => {
    if (found !== null || record === null || record.type !== "session_meta") {
      return found;
    }
    const payload = asRecord(record.payload);
    return payload === null
      ? null
      : (stringOf(payload.session_id) ?? stringOf(payload.id));
  }, null);

/**
 * Parses a Codex rollout. Pure over the file's lines, so the vendor half of the
 * reader is testable against a fixture with no provider and no disk.
 */
export const parseCodexTranscript = (lines: readonly string[]): Transcript => {
  const records = lines.map(parseLine);
  const items = records.flatMap((record, line) =>
    record === null ? [] : entriesOf(record, line, "response_item", draftOfItem)
  );
  const events = records.flatMap((record, line) =>
    record === null ? [] : entriesOf(record, line, "event_msg", draftOfEvent)
  );

  return {
    entries: items.length > 0 ? items : events,
    providerSessionId: sessionIdOf(records),
  };
};
