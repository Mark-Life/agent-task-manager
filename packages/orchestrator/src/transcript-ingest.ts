/**
 * The transcript a provider wrote to disk, read back after the run and
 * persisted.
 *
 * **There is no table for transcript messages, and this does not invent one.**
 * The schema has `agent_session` for the conversation and `run_event` for what
 * happened in it, and those are the two mechanisms used here: the provider's
 * own session id lands on the session row, which is what a resume is pointed
 * at, and the conversation itself lands as run events. The unclipped text has
 * no column anywhere, so it is kept the way an artifact is kept: the file is
 * the record, and the database holds the index into it.
 *
 * **The file is copied out of the agent home before that home is deleted.**
 * A provider writes its transcript inside the run's private config directory,
 * and that directory holds a copy of a live subscription credential, which is
 * why it is removed as the run's scope closes — so a transcript left there dies
 * with it. {@link preserveTranscript} copies exactly one file, the transcript
 * and nothing beside it, into the run directory: that directory survives
 * teardown, it is already where the run's event file and result file live, and
 * the credentials stay behind in the home and go with it.
 *
 * So after a run, durable in Postgres are the provider session id on the
 * session row, the timeline in `run_events` — clipped, and restored from the
 * transcript only when the stream left nothing — and one `agent_session_usage`
 * row holding what the session has spent. Durable on disk, and nowhere else, is
 * the whole conversation at full length in the run directory: no query returns
 * it, and removing the run directory removes it.
 *
 * **The usage summary is the one thing here that is a derived aggregate rather
 * than a copy.** It is stored precisely because it must outlive the bytes it
 * came from: a transcript cleaned up off the disk should not take the answer to
 * "what did this task cost" with it. See {@link recordUsage}.
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

import { join } from "node:path";
import {
  AgentSessionRepo,
  AgentSessionUsageRepo,
  RunEventRepo,
} from "@workspace/db";
import {
  RUN_EVENT_SUMMARY_BUDGET_BYTES,
  RUN_EVENT_TEXT_BUDGET_BYTES,
  type RunEventPayload,
  type Timestamp,
} from "@workspace/domain";
import {
  findTranscript,
  type RunLayout,
  readTranscript,
  readTranscriptAt,
  summarizeSession,
  type Transcript,
  type TranscriptEntry,
  transcriptChars,
} from "@workspace/harness";
import { clipError } from "@workspace/telemetry";
import { DateTime, Effect, Option, Schema } from "effect";
import { FileSystem } from "effect/FileSystem";
import {
  type DispatchContext,
  sessionIdOf,
  subjectOf,
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

/**
 * What the preserved transcript is called in the run directory.
 *
 * One name for every provider, because the vendor's own naming is a fact about
 * the directory it was copied out of — Claude names the file after the session
 * and Codex after the rollout — and a run directory holds one run. Both
 * vendors write JSONL and both parsers read the session id out of the content
 * rather than the filename, so nothing is lost by renaming it.
 */
export const TRANSCRIPT_FILE = "transcript.jsonl";

/**
 * The run's transcript where it outlives the run: beside the event file, in the
 * directory that survives the container and the agent home.
 *
 * Over a {@link RunLayout} rather than a dispatch context, because a reader
 * showing a finished run has a run id and a data root and none of the rest of
 * one — `hostRunLayout` turns those two into the directory this then names.
 *
 * Derived here rather than in the harness's layout because that layout is the
 * contract three parties share — the sandbox mounts it, the provider inside the
 * container is pointed at it, the orchestrator reads it back — and this file is
 * written and read by the orchestrator alone. Nothing inside a container ever
 * sees it.
 */
export const durableTranscriptPathOf = (layout: RunLayout) =>
  join(layout.runDir, TRANSCRIPT_FILE);

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
  /**
   * The host's shared login directory for this run's provider, which is where
   * the vendor writes every conversation on the box.
   */
  readonly agentHomeDir: string;
  readonly context: DispatchContext;
  /**
   * The id the run's terminus reported, or null where it never named one.
   *
   * Null means there is nothing to read, and that is the whole safety property:
   * every run on the host writes into one shared tree, so a fallback to the
   * newest file by mtime would hand this run a neighbour's conversation —
   * silently, and onward into the durable per-run copy everything else reads.
   */
  readonly providerSessionId: string | null;
}

/** Names the run a transcript failure was about, so a log line says which one. */
const failingRun = (context: DispatchContext) =>
  Effect.mapError(
    (cause: unknown) =>
      new IngestFailed({ cause, runId: context.runId, source: "transcript" })
  );

/** Where a run's transcript ended up, and where it was copied from. */
export interface PreserveTranscriptReport {
  /** False when the provider wrote no transcript, which is a crash before the first turn. */
  readonly copied: boolean;
  /** The durable copy, in the run directory. Null when there was nothing to copy. */
  readonly path: string | null;
  /** The provider's own file inside the agent home, which is about to be deleted. */
  readonly source: string | null;
}

const NOTHING_TO_PRESERVE: PreserveTranscriptReport = {
  copied: false,
  path: null,
  source: null,
};

/**
 * Copies the run's transcript out of the shared agent home and into its run
 * directory.
 *
 * The home is not going anywhere — it is the host's own login, shared by every
 * run — so this is no longer a rescue. It is what bounds how much of that
 * shared tree has to be kept: the durable copy is the run's record, and it is
 * what makes a re-ingest weeks later read exactly the bytes the first one did.
 *
 * One file and one file only, named by the session this run actually held. A
 * directory copy would carry out every other run's conversation and the
 * operator's own credential with it.
 *
 * Overwrites rather than skipping an existing copy. A second pass over the same
 * run reads the same provider file and writes the same bytes, so the operation
 * is repeatable — and a first pass interrupted mid-write leaves a partial file
 * that the second one is expected to replace.
 */
export const preserveTranscript = Effect.fn("Ingest.preserveTranscript")(
  function* (input: TranscriptIngestInput) {
    const { context } = input;
    const fs = yield* FileSystem;
    yield* Effect.annotateCurrentSpan({
      provider: context.provider,
      runId: context.runId,
    });

    const { providerSessionId } = input;
    if (providerSessionId === null) {
      return NOTHING_TO_PRESERVE;
    }
    const source = yield* findTranscript({
      agentHomeDir: input.agentHomeDir,
      provider: context.provider,
      providerSessionId,
    }).pipe(
      Effect.catchTag("Harness.TranscriptNotFound", () => Effect.succeed(null)),
      failingRun(context)
    );
    if (source === null) {
      return NOTHING_TO_PRESERVE;
    }

    const path = durableTranscriptPathOf(context.layout);
    yield* fs.copyFile(source, path).pipe(failingRun(context));
    return { copied: true, path, source } satisfies PreserveTranscriptReport;
  }
);

/**
 * The run's transcript, preferring the durable copy over the provider's own
 * file.
 *
 * The copy is the record after the run: it is what is left once the agent home
 * is gone, so a re-ingest weeks later reads exactly the bytes the first ingest
 * read. The scan of the agent home stays as the fallback for the one window
 * where the copy does not exist yet — a caller ingesting inside the run's own
 * scope — and for a run whose copy failed while its home was still there.
 */
const readRunTranscript = Effect.fnUntraced(function* (
  input: TranscriptIngestInput
) {
  const { context } = input;
  const fs = yield* FileSystem;
  const durable = durableTranscriptPathOf(context.layout);
  const preserved = yield* fs
    .exists(durable)
    .pipe(Effect.orElseSucceed(() => false));
  if (preserved) {
    return yield* readTranscriptAt(durable, context.provider);
  }
  // No copy and no session id is a run that ended before the provider named
  // its conversation. There is nothing to read, and reading the newest file in
  // a tree every run writes into would be reading somebody else's.
  if (input.providerSessionId === null) {
    return null;
  }
  return yield* readTranscript({
    agentHomeDir: input.agentHomeDir,
    provider: context.provider,
    providerSessionId: input.providerSessionId,
  });
});

/**
 * Derives what the session has spent and stores it against the session row.
 *
 * **Here, rather than on read.** The alternative was for the gateway to parse
 * the transcript when somebody opened the panel, and it fails on both counts:
 * the gateway has no transcript parser and giving it one means pulling both
 * vendor SDKs into the public-facing process, and a transcript that has been
 * cleaned up off the disk would take the session's history with it. This runs
 * where the bytes are already in hand — the ingest has just read the file to
 * preserve it — and what it leaves behind outlives the file.
 *
 * **Over the whole transcript, every time.** A session's file accumulates
 * across the runs that resume it, so each pass recomputes the total rather than
 * adding to it, and the write replaces the row. That is what makes a re-ingest
 * of the same run produce the same summary, and an ingest of a file that has
 * since grown produce the larger one.
 *
 * The consequence, which the UI has to say out loud: a session with a run in
 * flight shows the figures as of its last completed run, and `computedAt` is
 * how a reader knows that.
 */
const recordUsage = Effect.fnUntraced(function* (input: {
  readonly context: DispatchContext;
  readonly transcript: Pick<Transcript, "entries" | "usage">;
}) {
  const usage = yield* AgentSessionUsageRepo;
  const computedAt = yield* DateTime.now;
  const summary = summarizeSession({
    computedAt,
    provider: input.context.provider,
    transcript: input.transcript,
  });
  yield* usage.record({
    sessionId: sessionIdOf(input.context),
    usage: summary,
    workspaceId: workspaceIdOf(input.context),
  });
  return summary.requests;
});

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
  /** Model requests the transcript recorded, and the summary now covers. */
  readonly requests: number;
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
  requests: 0,
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
 * row, stores what the session has spent, and restores the timeline where the
 * event stream left none.
 *
 * A missing transcript is a report rather than a failure. A container that died
 * before the provider started wrote no file, and the run still has to close
 * out — an ingest that failed there would turn "the run crashed early" into
 * "the loop crashed reading about it".
 *
 * Idempotent on every pass: the rows collide on `(runId, seq)`, the session
 * write happens only on a difference, and the file it reads is the durable copy
 * — so a re-ingest of a run whose container and agent home are long gone
 * reports the same numbers the first one did.
 */
export const ingestTranscript = Effect.fn("Ingest.transcript")(function* (
  input: TranscriptIngestInput
) {
  const { context } = input;
  yield* Effect.annotateCurrentSpan({
    provider: context.provider,
    runId: context.runId,
  });

  const transcript = yield* readRunTranscript(input).pipe(
    Effect.catchTag("Harness.TranscriptNotFound", () => Effect.succeed(null)),
    failingRun(context)
  );
  if (transcript === null) {
    return NOT_FOUND;
  }

  const providerSessionId =
    transcript.providerSessionId ?? input.providerSessionId;
  if (providerSessionId !== null) {
    yield* recordProviderSession({ context, providerSessionId }).pipe(
      failingRun(context)
    );
  }

  const requests = yield* recordUsage({ context, transcript }).pipe(
    failingRun(context)
  );

  const streamed = yield* hasStreamedTimeline(context).pipe(
    failingRun(context)
  );

  const base = {
    appended: 0,
    chars: transcriptChars(transcript.entries),
    entries: transcript.entries.length,
    found: true,
    path: transcript.path,
    providerSessionId,
    requests,
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
        subject: subjectOf(context),
        workspaceId: workspaceIdOf(context),
      }))
    )
    .pipe(failingRun(context));

  return { ...base, appended: written.length, restored: true };
});
