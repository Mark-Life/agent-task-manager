/**
 * Reading Claude Code's transcript: one JSONL file per session under the
 * config directory's `projects/<workspace>/` folder.
 *
 * The file is an append-only log of envelopes, each with a `type` and, for the
 * two that matter, an Anthropic-shaped `message` inside it. The conversation is
 * therefore not one entry per line: a single `assistant` line carries thinking,
 * prose and several tool calls as separate content blocks, and one `user` line
 * carries the results of all of them. Flattening those blocks is most of what
 * this file does, because a reader wants the tool call next to its result and
 * not buried in an array.
 *
 * Everything else Claude writes to the same file is bookkeeping for its own UI —
 * mode changes, attachments, file-history snapshots, the generated title — and
 * is skipped. The skip is by allow-list rather than a deny-list of known noise:
 * an envelope type added in a future release should be ignored, not guessed at.
 *
 * Pure and total. A truncated last line — the normal state of a file whose
 * process was killed — is dropped, not raised.
 */

import type {
  Transcript,
  TranscriptEntry,
  TranscriptRole,
  TranscriptUsage,
} from "./transcript";

/** An envelope, once it is known to be an object. Fields are read defensively; none is guaranteed. */
type Line = Readonly<Record<string, unknown>>;

/**
 * The envelope types that carry conversation, and the role a message's own
 * blocks default to before tool traffic overrides it. Everything else in the
 * file — mode changes, attachments, snapshots, the generated title — is UI
 * state and is skipped by not being listed here.
 */
const SPEAKER_OF_TYPE = {
  assistant: "assistant",
  system: "system",
  user: "user",
} as const satisfies Record<string, TranscriptRole>;

/** Whether an envelope is one of the three that carry conversation. */
const isConversationType = (
  type: string
): type is keyof typeof SPEAKER_OF_TYPE => type in SPEAKER_OF_TYPE;

/** Whether a parsed JSON value is a plain object, which every envelope and block is. */
const isRecord = (value: unknown): value is Line =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/** A nested object field, or null when it is absent or of another shape. */
const asRecord = (value: unknown) => (isRecord(value) ? value : null);

/** A string field, or null when the field is absent or of another type. */
const stringOf = (value: unknown) => (typeof value === "string" ? value : null);

/**
 * A token count, or null when the field is absent or of another type. Negative
 * and fractional readings are refused rather than clamped: neither is a token
 * count, and a clamp would turn a vendor's bug into our own plausible number.
 */
const countOf = (value: unknown) =>
  typeof value === "number" && Number.isInteger(value) && value >= 0
    ? value
    : null;

/** One line of JSONL, or null when it is malformed or truncated mid-write. */
const parseLine = (line: string) => {
  try {
    return asRecord(JSON.parse(line));
  } catch {
    return null;
  }
};

/** What a draft entry leaves to the defaults: everything that is not tool traffic. */
interface EntryDraft {
  readonly callId?: string;
  /** Set only where it is not `text.length` — that is, on reasoning. */
  readonly chars?: number;
  readonly ok?: boolean;
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
 * A tool result's payload, which Claude writes as a bare string for simple
 * tools and as content blocks for the ones that return images beside text.
 * Non-text blocks contribute nothing: an image is not something a transcript
 * record can carry, and a placeholder for it would be counted as content.
 */
const textOfResult = (content: unknown): string => {
  const direct = stringOf(content);
  if (direct !== null) {
    return direct;
  }
  if (!Array.isArray(content)) {
    return "";
  }
  return content
    .map((block) => stringOf(asRecord(block)?.text) ?? "")
    .filter((text) => text.length > 0)
    .join("\n");
};

/**
 * One content block, as an entry. Null for the kinds that carry no readable
 * content — images, documents, and whatever a future SDK adds.
 *
 * Thinking is measured and not quoted, here as everywhere else: the text is
 * signed, private to the provider, and a stored copy is a liability with no
 * reader. The count survives so a turn that thought for ten thousand
 * characters and said nothing is still visible as that.
 */
const draftOfBlock = (
  block: Line,
  speaker: TranscriptRole
): EntryDraft | null => {
  switch (stringOf(block.type)) {
    case "text":
      return { role: speaker, text: stringOf(block.text) ?? "" };
    case "thinking":
      return {
        chars: (stringOf(block.thinking) ?? "").length,
        role: "reasoning",
        text: "",
      };
    case "redacted_thinking":
      return { chars: 0, role: "reasoning", text: "" };
    case "tool_use": {
      const input =
        block.input === undefined ? "" : JSON.stringify(block.input);
      return {
        callId: stringOf(block.id) ?? "",
        role: "tool_call",
        text: input,
        toolName: stringOf(block.name) ?? "",
      };
    }
    case "tool_result":
      return {
        callId: stringOf(block.tool_use_id) ?? "",
        ok: block.is_error !== true,
        role: "tool_result",
        text: textOfResult(block.content),
      };
    default:
      return null;
  }
};

/**
 * The entries one envelope produces: none for bookkeeping, one for a plain
 * string message, and one per content block otherwise.
 */
const entriesOf = (record: Line, line: number): readonly TranscriptEntry[] => {
  const type = stringOf(record.type) ?? "";
  if (!isConversationType(type)) {
    return [];
  }
  const speaker = SPEAKER_OF_TYPE[type];
  const occurredAt = stringOf(record.timestamp);

  // A `system` envelope is hook and harness narration: its text sits at the top
  // level, because there is no model message to put it in.
  if (type === "system") {
    const text = stringOf(record.content);
    return text === null
      ? []
      : [toEntry({ role: "system", text }, line, occurredAt)];
  }

  const content = asRecord(record.message)?.content;
  const direct = stringOf(content);
  if (direct !== null) {
    return [toEntry({ role: speaker, text: direct }, line, occurredAt)];
  }
  if (!Array.isArray(content)) {
    return [];
  }
  return content.flatMap((raw) => {
    const block = asRecord(raw);
    const draft = block === null ? null : draftOfBlock(block, speaker);
    return draft === null ? [] : [toEntry(draft, line, occurredAt)];
  });
};

/**
 * One assistant line's usage reading, or null where the line carries none.
 *
 * Claude's `input_tokens` is already fresh input — the cache halves are counted
 * separately beside it — so nothing is subtracted here, unlike Codex. The
 * context is the three added together, which is what the request actually put
 * in front of the model.
 *
 * A reading of zero context is dropped rather than recorded. The SDK writes
 * synthetic assistant messages — a refusal it generated itself, a cancelled
 * request — with a `<synthetic>` model and an all-zero usage block, and those
 * are not requests: on the curve they read as the context collapsing to nothing
 * and back.
 */
const usageOf = (record: Line, line: number): TranscriptUsage | null => {
  const message = asRecord(record.message);
  const usage = message === null ? null : asRecord(message.usage);
  if (usage === null) {
    return null;
  }
  const input = countOf(usage.input_tokens);
  const cacheRead = countOf(usage.cache_read_input_tokens);
  const cacheWrite = countOf(usage.cache_creation_input_tokens);
  const context = (input ?? 0) + (cacheRead ?? 0) + (cacheWrite ?? 0);
  if (context === 0) {
    return null;
  }
  // The split between the two cache lifetimes, which are billed at different
  // multiples of input. Absent on an older file, where the total is all there
  // is and the summary prices it at the cheaper rate.
  const creation = asRecord(usage.cache_creation);
  return {
    cacheRead,
    cacheWrite,
    cacheWrite1h:
      creation === null ? null : countOf(creation.ephemeral_1h_input_tokens),
    cacheWrite5m:
      creation === null ? null : countOf(creation.ephemeral_5m_input_tokens),
    context,
    // Claude records no window of its own; the summary infers one from `model`.
    contextWindow: null,
    input,
    line,
    model: stringOf(message?.model),
    occurredAt: stringOf(record.timestamp),
    output: countOf(usage.output_tokens),
    // Thinking is billed as output and Claude does not separate it.
    reasoningOutput: null,
    speed: stringOf(usage.speed),
  };
};

/**
 * The readings the file holds, one per request rather than one per line.
 *
 * Both halves of that are load-bearing. **One response is written as several
 * lines** — the prose and each tool call arrive as their own `assistant`
 * envelope, all carrying the same `requestId` and the same usage block — so
 * counting lines inflates a session's output tokens and its cost by however
 * many tool calls it made. The first line of each request wins.
 *
 * **Sidechain lines are skipped.** Those are a subagent's conversation, which
 * has its own window and its own transcript; folded into this curve they read
 * as the main context jumping and falling back. A line with no `requestId` is
 * kept under its own ordinal rather than merged with its neighbours: an unnamed
 * request is not the same request as the last one.
 */
const usageStream = (
  records: readonly (Line | null)[]
): readonly TranscriptUsage[] => {
  const seen = new Set<string>();
  return records.flatMap((record, line) => {
    if (record === null || stringOf(record.type) !== "assistant") {
      return [];
    }
    if (record.isSidechain === true) {
      return [];
    }
    // An empty id is an absent one. Left as a key it would merge every
    // unnamed request in the file into the first of them.
    const named = stringOf(record.requestId);
    const key = named === null || named.length === 0 ? `line-${line}` : named;
    if (seen.has(key)) {
      return [];
    }
    const usage = usageOf(record, line);
    if (usage === null) {
      return [];
    }
    seen.add(key);
    return [usage];
  });
};

/**
 * Parses a Claude transcript. Pure over the file's lines, so the vendor half of
 * the reader is testable against a fixture with no provider and no disk.
 */
export const parseClaudeTranscript = (lines: readonly string[]): Transcript => {
  const records = lines.map(parseLine);
  const providerSessionId = records.reduce<string | null>(
    (found, record) =>
      found ?? (record === null ? null : stringOf(record.sessionId)),
    null
  );

  return {
    entries: records.flatMap((record, line) =>
      record === null ? [] : entriesOf(record, line)
    ),
    providerSessionId,
    usage: usageStream(records),
  };
};
