/**
 * Reading Pi's transcript: one JSONL file per session under the config
 * directory's `sessions/--<flattened-cwd>--/` folder, named
 * `<timestamp>_<session-id>.jsonl`.
 *
 * The file is an append-only *tree*, not a list. Every entry carries an `id`
 * and a `parentId`, and `/tree`, `/fork` and a re-submitted message all add a
 * branch rather than replacing anything — so a file can hold several
 * conversations that share a prefix, and reading it in file order reads all of
 * them interleaved. This parser reads it in file order anyway, and that is a
 * deliberate choice with a stated cost: the reader's callers want "what did
 * this agent actually do", which on a headless run is the whole file because
 * nothing headless branches. A run that was branched by hand in the TUI reads
 * here as both paths, in the order they were taken, which is more than the
 * truth rather than less than it.
 *
 * Everything Pi writes that is not a message — `model_change`,
 * `thinking_level_change`, labels, compaction records, extension entries — is
 * skipped. The skip is by allow-list: an entry type a later release adds should
 * be ignored, not guessed at.
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

/** An entry, once it is known to be an object. Fields are read defensively; none is guaranteed. */
type Line = Readonly<Record<string, unknown>>;

/**
 * The message roles that carry conversation, and the transcript role each
 * becomes. Pi's `custom` role is extension and hook output injected into the
 * conversation, which is what `system` means here.
 */
const SPEAKER_OF_ROLE = {
  assistant: "assistant",
  custom: "system",
  user: "user",
} as const satisfies Record<string, TranscriptRole>;

/** Whether a message role is one of the three that carry conversation. */
const isSpeakerRole = (role: string): role is keyof typeof SPEAKER_OF_ROLE =>
  role in SPEAKER_OF_ROLE;

/** Whether a parsed JSON value is a plain object, which every entry and block is. */
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
 * The readable text of a content array. Non-text blocks contribute nothing: an
 * image is not something a transcript record can carry, and a placeholder for
 * it would be counted as content.
 */
const textOfBlocks = (content: unknown): string => {
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
 * content — images, and whatever a later release adds.
 *
 * Thinking is measured and not quoted, here as everywhere else: the text is
 * the model's own, often signed, and a stored copy is a liability with no
 * reader. The count survives so a turn that thought for ten thousand characters
 * and said nothing is still visible as that.
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
    case "toolCall": {
      const args =
        block.arguments === undefined ? "" : JSON.stringify(block.arguments);
      return {
        callId: stringOf(block.id) ?? "",
        role: "tool_call",
        text: args,
        toolName: stringOf(block.name) ?? "",
      };
    }
    default:
      return null;
  }
};

/**
 * The entries one message produces.
 *
 * A tool result is its own message in Pi rather than a block inside a user
 * message, which is why it is handled before the block walk: it carries the
 * call id, the tool's name and whether it failed at the top level, and it has
 * no `role` in {@link SPEAKER_OF_ROLE} on purpose.
 */
const entriesOfMessage = (
  message: Line,
  line: number,
  occurredAt: string | null
): readonly TranscriptEntry[] => {
  const role = stringOf(message.role) ?? "";
  if (role === "toolResult") {
    return [
      toEntry(
        {
          callId: stringOf(message.toolCallId) ?? "",
          ok: message.isError !== true,
          role: "tool_result",
          text: textOfBlocks(message.content),
          toolName: stringOf(message.toolName) ?? "",
        },
        line,
        occurredAt
      ),
    ];
  }
  if (!isSpeakerRole(role)) {
    return [];
  }
  const speaker = SPEAKER_OF_ROLE[role];
  const { content } = message;
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
 * The entries one file entry produces: none for the bookkeeping kinds, and the
 * message's own otherwise.
 *
 * The stamp preferred is the envelope's, because that is when Pi wrote the line;
 * the message's own is a millisecond number rather than a string and would have
 * to be formatted to be comparable with the other two providers'.
 */
const entriesOf = (record: Line, line: number): readonly TranscriptEntry[] => {
  if (stringOf(record.type) !== "message") {
    return [];
  }
  const message = asRecord(record.message);
  return message === null
    ? []
    : entriesOfMessage(message, line, stringOf(record.timestamp));
};

/**
 * One assistant message's usage reading, or null where it carries none.
 *
 * Pi reports fresh input separately from the two cache figures, as Claude does
 * and unlike Codex, so nothing is subtracted here; the context is the three
 * added together, which is what the request actually put in front of the model.
 *
 * A reading of zero context is dropped. A message Pi wrote for a request that
 * never reached a provider — a connection error, an aborted turn — carries an
 * all-zero usage block, and on the growth curve those read as the context
 * collapsing to nothing and back.
 */
const usageOf = (record: Line, line: number): TranscriptUsage | null => {
  const message = asRecord(record.message);
  if (message === null || stringOf(message.role) !== "assistant") {
    return null;
  }
  const usage = asRecord(message.usage);
  if (usage === null) {
    return null;
  }
  const input = countOf(usage.input);
  const cacheRead = countOf(usage.cacheRead);
  const cacheWrite = countOf(usage.cacheWrite);
  const context = (input ?? 0) + (cacheRead ?? 0) + (cacheWrite ?? 0);
  if (context === 0) {
    return null;
  }
  return {
    cacheRead,
    cacheWrite,
    // Pi reports one cache-write total and does not split it by lifetime, so
    // the summary prices the whole of it at the cheaper rate — a floor rather
    // than a guess, which is the same treatment an older Claude file gets.
    cacheWrite1h: null,
    cacheWrite5m: null,
    context,
    // Pi writes no window of its own into the session file; the summary infers
    // one from `model`.
    contextWindow: null,
    input,
    line,
    model: stringOf(message.model),
    occurredAt: stringOf(record.timestamp),
    output: countOf(usage.output),
    reasoningOutput: countOf(usage.reasoning),
    // Pi has no speed tier; the field belongs to Claude's pricing and nothing
    // else fills it.
    speed: null,
  };
};

/**
 * Parses a Pi transcript. Pure over the file's lines, so the vendor half of the
 * reader is testable against a fixture with no provider and no disk.
 *
 * The session id comes from the header line Pi writes first, which is the same
 * id the file is named after and the same one `--session` takes — so the
 * address a run resumes by, the address its transcript is found by, and the
 * address inside the file are one value and cannot drift.
 *
 * One reading per assistant message, with no de-duplication: Pi writes one
 * assistant message per model request and puts every content block of it on
 * that one line, so there is nothing here of Claude's "one response, several
 * envelopes" problem to undo.
 */
export const parsePiTranscript = (lines: readonly string[]): Transcript => {
  const records = lines.map(parseLine);
  const providerSessionId = records.reduce<string | null>(
    (found, record) =>
      found ??
      (record === null || stringOf(record.type) !== "session"
        ? null
        : stringOf(record.id)),
    null
  );

  return {
    entries: records.flatMap((record, line) =>
      record === null ? [] : entriesOf(record, line)
    ),
    providerSessionId,
    usage: records.flatMap((record, line) => {
      if (record === null || stringOf(record.type) !== "message") {
        return [];
      }
      const usage = usageOf(record, line);
      return usage === null ? [] : [usage];
    }),
  };
};
