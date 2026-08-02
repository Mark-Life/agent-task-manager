/**
 * The transcript a provider wrote to disk, read back after the run and
 * persisted.
 *
 * **There is no table for transcript messages, and this does not invent one.**
 * The Phase 1 schema has `agent_session` for the conversation and `run_event`
 * for what happened in it, and those are the two mechanisms used here: the
 * provider's own session id lands on the session row, which is what a resume is
 * pointed at, and the conversation itself lands as run events. The file itself
 * does not outlive the run: the provider writes it inside the run's agent home,
 * which is removed with its credential copy as the run's scope closes. That is
 * why this pass runs inside that scope, and why whatever it does not store here
 * — the full, unclipped text above all — is gone.
 *
 * **The timeline is written from the transcript only when the event stream left
 * none.** A run that streamed normally already has its timeline: those rows are
 * the same conversation, normalized, and writing a second copy from the
 * transcript would give the dashboard two sources for one run and Postgres two
 * copies of every assistant message. The transcript's value is exactly the case
 * the stream cannot cover — a run killed between two events, or one whose event
 * file never made it back off the mount — and there it is the difference
 * between a `lost` run with a readable history and one with nothing at all.
 *
 * **Restored rows live in their own `seq` band.** `seq` is a file line ordinal,
 * and the two files number from zero independently, so a transcript row written
 * at the stream's ordinals would be a collision that means nothing. Offsetting
 * by {@link TRANSCRIPT_SEQ_BASE} keeps both idempotent — re-reading the same
 * transcript collides with itself, exactly as re-reading the event file does —
 * and makes the origin of a row readable from its ordinal: below the base is
 * what the run emitted, at or above it is what the provider wrote down.
 *
 * The text of a tool call is the provider's raw arguments, which is a `git` or
 * `gh` command line and therefore a credential. It is the one field here that
 * goes through the telemetry sanitizer rather than a plain clip.
 */

import { AgentSessionRepo, RunEventRepo } from "@workspace/db";
import {
  RUN_EVENT_SUMMARY_BUDGET_BYTES,
  RUN_EVENT_TEXT_BUDGET_BYTES,
  type RunEventPayload,
  type Timestamp,
} from "@workspace/domain";
import {
  readTranscript,
  type TranscriptEntry,
  transcriptChars,
} from "@workspace/harness";
import { clipError } from "@workspace/telemetry";
import { DateTime, Effect, Option, Schema } from "effect";
import {
  type DispatchContext,
  sessionIdOf,
  taskIdOf,
  workspaceIdOf,
} from "./dispatch-context";
import { IngestFailed } from "./errors";
import { clipToBytes, type RunEventDraft } from "./mapping";

/**
 * Where the restored band starts.
 *
 * A million, because it has to sit above any ordinal a real event file reaches
 * and stay obvious in a query someone reads by eye. The chattiest run we have
 * seen produces events in the low thousands, so the gap is three orders of
 * magnitude — and the band is only ever written when the event file produced
 * nothing at all, which makes a collision impossible rather than unlikely.
 */
export const TRANSCRIPT_SEQ_BASE = 1_000_000;

/** Whether a run event row came from the transcript rather than from the stream. */
export const isRestoredSeq = (seq: number) => seq >= TRANSCRIPT_SEQ_BASE;

const decodeInstant = Schema.decodeUnknownOption(Schema.DateTimeUtcFromString);

/** The short fields: every summary, log message and prefixed narration line. */
const clipSummary = (text: string) =>
  clipToBytes(text, RUN_EVENT_SUMMARY_BUDGET_BYTES);

/** The assistant's message, clipped, with the cut visible beside it. */
const assistantPayload = (entry: TranscriptEntry): RunEventPayload => {
  const text = clipToBytes(entry.text, RUN_EVENT_TEXT_BUDGET_BYTES);
  return text.length === entry.text.length
    ? { chars: text.length, kind: "assistant_message", text }
    : {
        chars: text.length,
        kind: "assistant_message",
        originalChars: entry.chars,
        text,
        truncated: true,
      };
};

/**
 * The run event one transcript entry becomes. Total over the reader's role
 * union, so a role added to the harness is a compile error here rather than a
 * hole in a restored timeline.
 *
 * `user` and `system` become log lines because the domain has no kind for
 * either, and dropping them would lose the answer to the first question a bad
 * run raises — what was this model actually told. The role is prefixed onto the
 * message, since a `log` payload has nowhere else to put it.
 */
const payloadOf = (entry: TranscriptEntry): RunEventPayload => {
  switch (entry.role) {
    case "assistant":
      return assistantPayload(entry);
    case "reasoning":
      return { chars: entry.chars, kind: "reasoning" };
    case "tool_call":
      return {
        // Empty where the provider paired nothing, which is what the reader
        // found — inventing an id would pair this call to a result at random.
        callId: entry.callId ?? "",
        inputChars: entry.chars,
        kind: "tool_call",
        // The one sanitized field: these are raw arguments, and a `gh` or `git`
        // invocation carries a token.
        summary: clipError(entry.text),
        toolName: entry.toolName ?? "unknown",
      };
    case "tool_result":
      return {
        callId: entry.callId ?? "",
        kind: "tool_result",
        // A provider that did not say is not a provider that said no: the
        // reader keeps that distinction as null, and the payload has no third
        // value for it, so silence reads as success.
        ok: entry.ok ?? true,
        outputChars: entry.chars,
        summary: clipSummary(entry.text),
      };
    default:
      return {
        kind: "log",
        level: "info",
        message: clipSummary(`${entry.role}: ${entry.text}`),
      };
  }
};

/** A parsed transcript and the clock to stamp the lines that carry none. */
export interface TranscriptDraftInput {
  readonly entries: readonly TranscriptEntry[];
  /** Used where the provider wrote no timestamp of its own. */
  readonly fallbackAt: Timestamp;
}

/**
 * The restored timeline, one draft per transcript entry.
 *
 * The ordinal is the entry's index, not its line: one message holding several
 * blocks parses to several entries sharing a line, and numbering by line would
 * make two rows fight over one `seq`. The index is stable under the only way a
 * transcript changes — being appended to — so a run ingested twice, once
 * half-written and once complete, agrees with itself on every row it already
 * had.
 */
export const toTranscriptDrafts = (
  input: TranscriptDraftInput
): readonly RunEventDraft[] =>
  input.entries.map((entry, index) => ({
    occurredAt: Option.getOrElse(
      decodeInstant(entry.occurredAt),
      () => input.fallbackAt
    ),
    payload: payloadOf(entry),
    seq: TRANSCRIPT_SEQ_BASE + index,
  }));

/** Which run's transcript, and which conversation to narrow the scan to. */
export interface TranscriptIngestInput {
  readonly context: DispatchContext;
  /**
   * The id the run's terminus reported, when it reported one. Null takes the
   * most recently written transcript under the run's directory, which is the
   * right answer for a run with one session and a crash before it named itself.
   */
  readonly providerSessionId: string | null;
}

/** What one pass over a run's transcript did. */
export interface TranscriptIngestReport {
  /** Rows this pass inserted. Zero when the stream already covered the run, and on a re-ingest. */
  readonly appended: number;
  /** Characters the conversation produced, reasoning included. Measured, never carried. */
  readonly chars: number;
  readonly entries: number;
  /** False when the provider wrote no transcript at all, which is a crash before the first turn. */
  readonly found: boolean;
  readonly path: string | null;
  /** The provider's own conversation id, as the file names it. */
  readonly providerSessionId: string | null;
  /** True when the timeline was rebuilt here because the event stream left none. */
  readonly restored: boolean;
}

const NOT_FOUND: TranscriptIngestReport = {
  appended: 0,
  chars: 0,
  entries: 0,
  found: false,
  path: null,
  providerSessionId: null,
  restored: false,
};

/** Whether this run already has a timeline from its own event stream. */
const hasStreamedTimeline = Effect.fnUntraced(function* (
  context: DispatchContext
) {
  const events = yield* RunEventRepo;
  // Oldest first, so the one row read is the lowest ordinal the run has — which
  // is below the band when the stream wrote anything at all, and inside it when
  // only a previous restore did.
  const [oldest] = yield* events.listByRun({
    limit: 1,
    runId: context.runId,
    workspaceId: workspaceIdOf(context),
  });
  return oldest !== undefined && !isRestoredSeq(oldest.seq);
});

/**
 * Records the id the provider minted, if the session row does not have it yet.
 *
 * Read first, write only on a difference. The write is audited like every other
 * mutation, so calling it unconditionally would put an audit row saying nothing
 * changed on every re-ingest — and the audit log answers "who changed this",
 * which stops being a useful answer once it is full of writes that changed
 * nothing.
 */
const recordProviderSession = Effect.fnUntraced(function* (input: {
  readonly context: DispatchContext;
  readonly providerSessionId: string;
}) {
  const sessions = yield* AgentSessionRepo;
  const ref = {
    id: sessionIdOf(input.context),
    workspaceId: workspaceIdOf(input.context),
  };
  const stored = yield* sessions.byId(ref);
  if (stored.providerSessionId === input.providerSessionId) {
    return false;
  }
  yield* sessions.recordProviderSession({
    ...ref,
    providerSessionId: input.providerSessionId,
  });
  return true;
});

/**
 * Reads the run's transcript, stamps the provider's session id on the session
 * row, and restores the timeline where the event stream left none.
 *
 * A missing transcript is a report rather than a failure. A container that died
 * before the provider started wrote no file, and the run still has to close
 * out — an ingest that failed there would turn "the run crashed early" into
 * "the loop crashed reading about it".
 */
export const ingestTranscript = Effect.fn("Ingest.transcript")(function* (
  input: TranscriptIngestInput
) {
  const { context } = input;
  yield* Effect.annotateCurrentSpan({
    provider: context.provider,
    runId: context.runId,
  });

  const transcript = yield* readTranscript({
    layout: context.layout,
    provider: context.provider,
    providerSessionId: input.providerSessionId,
  }).pipe(
    Effect.catchTag("Harness.TranscriptNotFound", () => Effect.succeed(null)),
    Effect.mapError(
      (cause) =>
        new IngestFailed({ cause, runId: context.runId, source: "transcript" })
    )
  );
  if (transcript === null) {
    return NOT_FOUND;
  }

  const providerSessionId =
    transcript.providerSessionId ?? input.providerSessionId;
  if (providerSessionId !== null) {
    yield* recordProviderSession({ context, providerSessionId }).pipe(
      Effect.mapError(
        (cause) =>
          new IngestFailed({
            cause,
            runId: context.runId,
            source: "transcript",
          })
      )
    );
  }

  const streamed = yield* hasStreamedTimeline(context).pipe(
    Effect.mapError(
      (cause) =>
        new IngestFailed({ cause, runId: context.runId, source: "transcript" })
    )
  );

  const base = {
    appended: 0,
    chars: transcriptChars(transcript.entries),
    entries: transcript.entries.length,
    found: true,
    path: transcript.path,
    providerSessionId,
    restored: false,
  } satisfies TranscriptIngestReport;

  if (streamed) {
    return base;
  }

  const fallbackAt = yield* DateTime.now;
  const drafts = toTranscriptDrafts({
    entries: transcript.entries,
    fallbackAt,
  });
  const events = yield* RunEventRepo;
  const written = yield* events
    .appendAll(
      drafts.map((draft) => ({
        occurredAt: draft.occurredAt,
        payload: draft.payload,
        runId: context.runId,
        seq: draft.seq,
        taskId: taskIdOf(context),
        workspaceId: workspaceIdOf(context),
      }))
    )
    .pipe(
      Effect.mapError(
        (cause) =>
          new IngestFailed({
            cause,
            runId: context.runId,
            source: "transcript",
          })
      )
    );

  return { ...base, appended: written.length, restored: true };
});
