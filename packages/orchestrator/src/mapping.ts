/**
 * The one place a normalized harness event becomes a row in a run's timeline.
 * Pure — nothing here touches a database, a disk or a clock.
 *
 * The mapping is total and one-to-one, and both halves are load-bearing. Total,
 * because the harness's union is closed and a kind with no case would be a run
 * whose timeline silently skips what it did. One-to-one, because the row's
 * `seq` is the 0-based ordinal of the line in the container's event file, not a
 * counter: `(runId, seq)` is unique, so re-ingesting the same file collides row
 * for row instead of duplicating a run's whole timeline. Anything here that
 * dropped an event, merged two, or emitted two rows for one line would shift
 * every ordinal after it and take that idempotence with it — which is why an
 * unparseable line still consumes its ordinal (see {@link toRunEventDrafts})
 * rather than being skipped.
 *
 * `@workspace/harness` already says which run-event kind each event becomes, so
 * nothing here re-derives it: `runEventKindOf` is the tag every case is checked
 * against in the tests, and `runOutcomeOf` is how a turn's terminus becomes the
 * run outcome the `finished` payload carries.
 *
 * The clip is this file's job because the domain says so — the repository
 * refuses an oversized payload rather than shortening one, since only the
 * writer knows which field is safe to cut and what the original length was. Two
 * budgets and two ways of showing the cut. An assistant message carries
 * `truncated` and `originalChars` beside the text, which is the domain's own
 * shape for a visible clip. A tool call, a tool result, a log line and an error
 * have no such fields — so their text is held to the summary budget and the
 * size that was really there is already on the row beside it as `inputChars` /
 * `outputChars`. Neither is silent.
 *
 * One kind is never produced here. `stopped` names the command that killed a
 * run, and only the orchestrator holds that id — it is written at the stop, not
 * ingested from a stream.
 */

import type { RunEventPayload, Timestamp } from "@workspace/domain";
import {
  RUN_EVENT_SUMMARY_BUDGET_BYTES,
  RUN_EVENT_TEXT_BUDGET_BYTES,
} from "@workspace/domain";
import type { AgentEvent, AgentEventRecord } from "@workspace/harness";
import { runOutcomeOf } from "@workspace/harness";

const encoder = new TextEncoder();
const decoder = new TextDecoder();

/**
 * The byte range UTF-8 uses for the second and later bytes of a character.
 * Nothing in that range ever starts one, which is what makes walking backwards
 * off a cut land on a boundary.
 */
const CONTINUATION_MIN = 0x80;
const CONTINUATION_MAX = 0xbf;

const isContinuation = (byte: number | undefined) =>
  byte !== undefined && byte >= CONTINUATION_MIN && byte <= CONTINUATION_MAX;

/**
 * The longest prefix of `text` that encodes to at most `budgetBytes` bytes.
 *
 * Bytes rather than characters, because the budgets are the database's and the
 * database counts bytes — a clip by character length passes a text of emoji
 * straight through a limit it is three times over. The cut is walked back to a
 * UTF-8 character boundary rather than decoded leniently, so a clipped string
 * never ends in a replacement character that the reader would take for content.
 */
export const clipToBytes = (text: string, budgetBytes: number) => {
  const bytes = encoder.encode(text);
  if (bytes.length <= budgetBytes) {
    return text;
  }
  let end = budgetBytes;
  while (end > 0 && isContinuation(bytes[end])) {
    end -= 1;
  }
  return decoder.decode(bytes.subarray(0, end));
};

/** A clipped field, and what it took to clip it. */
interface ClippedText {
  /** Characters actually stored. */
  readonly chars: number;
  /** Characters the run really produced. */
  readonly originalChars: number;
  readonly text: string;
  readonly truncated: boolean;
}

const clipText = (text: string, budgetBytes: number): ClippedText => {
  const clipped = clipToBytes(text, budgetBytes);
  return {
    chars: clipped.length,
    originalChars: text.length,
    text: clipped,
    truncated: clipped.length !== text.length,
  };
};

/** The short fields: every summary, log message and error message. */
const clipSummary = (text: string) =>
  clipToBytes(text, RUN_EVENT_SUMMARY_BUDGET_BYTES);

/**
 * What a run event needs that the event itself cannot know. Each of the three
 * belongs to the caller by construction: the prompt was assembled before the
 * container started, the image was chosen by dispatch, and the exit code is
 * only known once the container is gone.
 */
export interface MappingContext {
  /** The container's exit code, or null where it never produced one. */
  readonly exitCode: number | null;
  /** How much prompt this run was given. Measured, never carried. */
  readonly promptChars: number;
  /** The image that actually ran. */
  readonly sandboxImage: string | null;
}

/** A subagent's lifecycle, as one line of the run's log. */
const subagentMessage = (event: AgentEvent): string => {
  if (event.kind === "subagent_started") {
    return `subagent started: ${event.description} [${event.subagentId}]`;
  }
  if (event.kind === "subagent_done") {
    return `subagent ${event.status}: ${event.description} [${event.subagentId}]`;
  }
  return "";
};

/** The assistant's message, clipped, with the cut visible beside it. */
const assistantPayload = (text: string): RunEventPayload => {
  const clipped = clipText(text, RUN_EVENT_TEXT_BUDGET_BYTES);
  return clipped.truncated
    ? {
        chars: clipped.chars,
        kind: "assistant_message",
        originalChars: clipped.originalChars,
        text: clipped.text,
        truncated: true,
      }
    : { chars: clipped.chars, kind: "assistant_message", text: clipped.text };
};

/**
 * The terminus, split the way `runEventKindOf` splits it: a clean turn is
 * `finished` and everything else is `failed`.
 *
 * `finished` is the one place a null economic becomes a zero, and it is the
 * domain's decision rather than this file's — the payload's fields are
 * `Natural` and a clean turn that reported no numbers still has to say
 * something. The honest nulls live on the run row, which is what anything
 * averaging a cost reads.
 */
const resultPayload = (
  event: Extract<AgentEvent, { readonly kind: "result" }>,
  context: MappingContext
): RunEventPayload =>
  event.outcome === "done"
    ? {
        costUsd: event.costUsd,
        durationMs: event.durationMs ?? 0,
        kind: "finished",
        outcome: runOutcomeOf(event.outcome),
        totalTokens: event.totalTokens ?? 0,
        turns: event.turns ?? 0,
      }
    : {
        errorClass: event.errorClass ?? "Unknown",
        errorMessage: clipSummary(
          event.errorMessage ?? `the turn ended ${event.outcome}`
        ),
        exitCode: context.exitCode,
        kind: "failed",
      };

/**
 * The run event one normalized harness event becomes. Total over the harness's
 * union, so a new event kind is a compile error here rather than a hole in a
 * run's timeline.
 */
export const toRunEventPayload = (
  event: AgentEvent,
  context: MappingContext
): RunEventPayload => {
  switch (event.kind) {
    case "session_init":
      return {
        kind: "started",
        model: event.model,
        promptChars: context.promptChars,
        provider: event.provider,
        sandboxImage: context.sandboxImage,
      };
    case "assistant_text":
      return assistantPayload(event.text);
    case "reasoning":
      return { chars: event.chars, kind: "reasoning" };
    case "tool_call":
      return {
        callId: event.callId,
        inputChars: event.inputChars,
        kind: "tool_call",
        summary: clipSummary(event.summary),
        toolName: event.toolName,
      };
    case "tool_result":
      return {
        callId: event.callId,
        kind: "tool_result",
        ok: event.ok,
        outputChars: event.outputChars,
        summary: clipSummary(event.summary),
      };
    case "usage":
      return {
        costUsd: event.costUsd,
        inputTokens: event.inputTokens ?? 0,
        kind: "usage",
        outputTokens: event.outputTokens ?? 0,
        rateLimitPct: event.rateLimitPct,
        turns: event.turns ?? 0,
      };
    case "log":
      return {
        kind: "log",
        level: event.level,
        message: clipSummary(event.message),
      };
    // The domain has no subagent kind: the fan-out counts ride the turn's wide
    // event, and inventing one here would put a migration between the harness
    // and the timeline.
    case "subagent_started":
    case "subagent_done":
      return {
        kind: "log",
        level: "info",
        message: clipSummary(subagentMessage(event)),
      };
    case "error":
      return {
        errorClass: event.errorClass,
        errorMessage: clipSummary(event.errorMessage),
        kind: "error",
      };
    default:
      return resultPayload(event, context);
  }
};

/**
 * One row the ingest is about to insert, before the ids it shares with every
 * other row of the run are stamped on it.
 */
export interface RunEventDraft {
  /** The harness clock inside the container; the host stamps its own at insert. */
  readonly occurredAt: Timestamp;
  readonly payload: RunEventPayload;
  /** The 0-based line ordinal in the container's event file. */
  readonly seq: number;
}

/**
 * The run's whole timeline, one draft per line of its event file.
 *
 * A line that could not be decoded is passed in as `null` and produces no
 * draft, but still consumes its ordinal — which is the whole reason the input
 * is a sparse array rather than the parsed records alone. Compacting first
 * would renumber every event after the bad line, and a re-ingest after a fix
 * would then write a second, shifted copy of the run instead of colliding with
 * the first.
 */
export const toRunEventDrafts = (
  records: readonly (AgentEventRecord | null)[],
  context: MappingContext
): readonly RunEventDraft[] =>
  records.flatMap((record, seq) =>
    record === null
      ? []
      : [
          {
            occurredAt: record.occurredAt,
            payload: toRunEventPayload(record.event, context),
            seq,
          },
        ]
  );
