/**
 * What the orchestrator collects off a run's directory once the container is
 * gone.
 *
 * A run leaves three kinds of record behind, and none of them can be read while
 * it is still running. The normalized event file is the run's timeline. The
 * ledger directory holds the `atm.turn` rows the harness wrote from inside,
 * which is the only place the model's economics exist. The task's artifacts
 * folder holds whatever files the agent decided to keep, and its index is
 * rebuilt by `./artifacts`. This module owns the first two.
 *
 * Everything here is idempotent, and that is the design constraint rather than
 * a nicety. Ingest runs after teardown, which is exactly where a crash, a
 * restart or an operator re-running a check lands twice — so re-reading an
 * unchanged file writes nothing, and re-reading a file that grew writes only
 * its tail. The mechanism is the `(runId, seq)` uniqueness the domain gives
 * `run_event`: `seq` is the line ordinal in the file, so the second ingest
 * collides row for row instead of writing a shifted second copy of the run.
 * Nothing here counts rows to decide whether it has run before.
 *
 * Reads are total over a damaged directory. A missing file is not a failure —
 * a container that died before its first event wrote none, and a run that
 * never reached the provider has no ledger — so an absent path ingests to
 * nothing. Only a path that exists and cannot be read is an {@link IngestFailed},
 * and even that costs the record rather than the work: the container is already
 * gone, so the caller closes the run out regardless.
 */

import { join } from "node:path";
import { RunEventRepo } from "@workspace/db";
import { AgentEventRecord } from "@workspace/harness";
import { eventLogDirOf } from "@workspace/sandbox";
import { Effect, Option, Schema } from "effect";
import { FileSystem } from "effect/FileSystem";
import {
  type DispatchContext,
  eventLogPathOf,
  taskIdOf,
  workspaceIdOf,
} from "./dispatch-context";
import { IngestFailed } from "./errors";
import { type MappingContext, toRunEventDrafts } from "./mapping";
import { foldTurnRows, parseTurnRow, type TurnRollup } from "./turn-rollup";

/** Suffix of every wide-event ledger `@workspace/telemetry` writes. */
const LEDGER_SUFFIX = ".jsonl";

/**
 * The lines of a JSONL file, blank ones dropped. Blank lines carry no ordinal
 * of their own: a trailing newline is how every append ends, and letting the
 * empty tail consume a `seq` would shift the whole file the next time a line
 * was added after it.
 */
const linesOf = (content: string) =>
  content.split("\n").filter((line) => line.trim().length > 0);

const decodeAgentEvent = Schema.decodeUnknownOption(AgentEventRecord);

/** One line of the normalized event file, or nothing where it cannot be read. */
const parseEventLine = (line: string) => {
  try {
    return Option.getOrNull(decodeAgentEvent(JSON.parse(line)));
  } catch {
    return null;
  }
};

/** Reads a file, or nothing at all where there is no file to read. */
const readOptionalFile = Effect.fnUntraced(function* (path: string) {
  const fs = yield* FileSystem;
  const present = yield* fs
    .exists(path)
    .pipe(Effect.orElseSucceed(() => false));
  return present
    ? yield* Effect.option(fs.readFileString(path))
    : Option.none();
});

/** Which run's files, and the three facts a run event needs that no event carries. */
export interface RunIngestInput {
  readonly context: DispatchContext;
  /** The container's exit code, or null where it never produced one. */
  readonly exitCode: number | null;
  /** How much prompt the run was given. Measured, never carried. */
  readonly promptChars: number;
}

/** What one pass over the normalized event file did. */
export interface RunEventIngestReport {
  /** Rows this pass actually inserted. Zero on a re-ingest of an unchanged file. */
  readonly appended: number;
  /** Lines the file held, including the ones that could not be decoded. */
  readonly lines: number;
  /** Lines that were present and unreadable. A count, because each one cost an ordinal. */
  readonly unreadable: number;
}

const mappingContextOf = (input: RunIngestInput): MappingContext => ({
  exitCode: input.exitCode,
  promptChars: input.promptChars,
  sandboxImage: input.context.image,
});

/**
 * Reads the run's normalized event file back and writes its timeline.
 *
 * The pass is a reconcile rather than the primary write path: a run streaming
 * events into the database as they arrive has already written most of these,
 * and this is what closes the gap between the last row that made it and the
 * moment the container stopped. Because both write the same `(runId, seq)`
 * pairs — the ordinal is the file's, not a counter — running both is
 * self-correcting instead of duplicating.
 *
 * An unreadable line still consumes its ordinal. That is the one rule the
 * idempotence rests on: compacting the bad lines away would renumber every
 * event after them, and a re-ingest once the decoder is fixed would write a
 * second, shifted copy of the run rather than colliding with the first.
 */
export const ingestRunEvents = Effect.fn("Ingest.runEvents")(function* (
  input: RunIngestInput
) {
  const { context } = input;
  const path = eventLogPathOf(context);
  yield* Effect.annotateCurrentSpan({ path, runId: context.runId });

  const content = yield* readOptionalFile(path).pipe(
    Effect.mapError(
      (cause) =>
        new IngestFailed({ cause, runId: context.runId, source: "events" })
    )
  );
  if (Option.isNone(content)) {
    return {
      appended: 0,
      lines: 0,
      unreadable: 0,
    } satisfies RunEventIngestReport;
  }

  const lines = linesOf(content.value);
  const records = lines.map(parseEventLine);
  const drafts = toRunEventDrafts(records, mappingContextOf(input));

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
          new IngestFailed({ cause, runId: context.runId, source: "events" })
      )
    );

  return {
    appended: written.length,
    lines: lines.length,
    unreadable: records.filter((record) => record === null).length,
  } satisfies RunEventIngestReport;
});

/**
 * Every `atm.turn` row under the run's ledger directory.
 *
 * The whole directory rather than one named file, because the file is named
 * after the service that wrote it and the service inside a container is not
 * this loop's to name. Filtering by marker and by `runId` is what makes that
 * safe, and it is done in {@link parseTurnRow} and {@link foldTurnRows}.
 */
const readLedgerRows = Effect.fnUntraced(function* (directory: string) {
  const fs = yield* FileSystem;
  const entries = yield* fs
    .readDirectory(directory)
    .pipe(Effect.orElseSucceed((): readonly string[] => []));
  const ledgers = entries.filter((entry) => entry.endsWith(LEDGER_SUFFIX));
  const files = yield* Effect.forEach(ledgers, (entry) =>
    readOptionalFile(join(directory, entry))
  );
  return files
    .filter(Option.isSome)
    .flatMap((file) => linesOf(file.value))
    .map(parseTurnRow)
    .filter((row) => row !== null);
});

/**
 * Folds the container's own wide events into the numbers the host reports.
 *
 * This is the join between the two halves of a run. The loop knows when the
 * container started and how it exited; the model's cost, tokens and turn count
 * exist only inside it, and travel out as JSON lines on a mount because a
 * container has no database handle and should not have one. Reading them here
 * is what lets one query answer "what did this run cost" without anybody
 * correlating two systems by hand.
 *
 * A missing ledger rolls up to {@link EMPTY_TURN_ROLLUP} rather than failing.
 * A container killed before the provider answered genuinely reported nothing,
 * and a run with no economics is a fact worth recording — not an error.
 */
export const ingestTurnLedger = Effect.fn("Ingest.turnLedger")(
  function* (input: { readonly context: DispatchContext }) {
    const { context } = input;
    const directory = eventLogDirOf(context.layout.runDir);
    yield* Effect.annotateCurrentSpan({ directory, runId: context.runId });

    const rows = yield* readLedgerRows(directory).pipe(
      Effect.mapError(
        (cause) =>
          new IngestFailed({ cause, runId: context.runId, source: "events" })
      )
    );
    const rollup = foldTurnRows({ rows, runId: context.runId });
    yield* Effect.annotateCurrentSpan({ turnCount: rollup.turnCount });
    return rollup satisfies TurnRollup;
  }
);
