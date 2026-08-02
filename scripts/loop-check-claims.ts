/**
 * How `loop:check` states one claim, and the files a claim is read out of.
 *
 * Both halves are here because they are the same idea. A claim is a value —
 * failing rather than throwing is what makes the whole check one effect that
 * stops at the first broken claim and exits non-zero — and the evidence for one
 * is a file on disk rather than something the check held in memory.
 *
 * **The ledger is read off the disk, deliberately.** The rows a run leaves are
 * what survives the process, and two of the claims here are about processes
 * that no longer exist: the killed loop's start row was written by a pid that
 * is gone, and in the contained mode the `atm.turn` row was written inside a
 * container that has been removed, into a file the host can only see because of
 * a bind mount. An in-memory sink would prove neither.
 */

import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { RunId } from "@workspace/domain";
import {
  hostRunLayout,
  runDirOf,
  TURN_EVENT_MARKER,
  TURN_LEDGER_SERVICE,
  TurnEvent,
} from "@workspace/harness";
import {
  durableTranscriptPathOf,
  RUN_EVENT_MARKER,
  RunEvent,
} from "@workspace/orchestrator";
import {
  eventLogDirOf,
  SANDBOX_EVENT_MARKER,
  SandboxEvent,
} from "@workspace/sandbox";
import { Effect, type Option, Schema } from "effect";

/**
 * One thing the loop was supposed to do and did not.
 *
 * The two fields are rendered into `message` because this is what a failing
 * check exits on: the runner prints the error and nothing else, and a tag with
 * a line number does not tell an operator which claim broke or what was found
 * instead.
 */
export class CheckFailed extends Schema.TaggedErrorClass<CheckFailed>()(
  "LoopCheck.Failed",
  { detail: Schema.String, step: Schema.String }
) {
  override get message() {
    return `${this.step} — ${this.detail}`;
  }
}

/** Asserts one claim, naming what was expected when it does not hold. */
export const check = (options: {
  readonly detail: string;
  readonly ok: boolean;
  readonly step: string;
}) =>
  options.ok
    ? Effect.logInfo(`ok    ${options.step}`)
    : Effect.fail(
        new CheckFailed({ detail: options.detail, step: options.step })
      );

/** One decoded `atm.run` row of the ledger this check wrote to. */
export type LedgerRow = typeof RunEvent.rowSchema.Type;

const decodeRunRow = Schema.decodeUnknownOption(RunEvent.rowSchema);
const decodeSandboxRow = Schema.decodeUnknownOption(SandboxEvent.rowSchema);
const decodeTurnRow = Schema.decodeUnknownOption(TurnEvent.rowSchema);

/**
 * The rows of one wide event that belong to one run, read off a JSONL file the
 * way `bun run logs` reads it: a line that is not JSON, is another unit's, or
 * is another run's, is skipped rather than failing the read.
 */
const ledgerRows = <Row extends { readonly runId: string | null }>(input: {
  readonly decode: (value: unknown) => Option.Option<Row>;
  readonly marker: string;
  readonly path: string;
  readonly runId: string;
}): Row[] => {
  if (!existsSync(input.path)) {
    return [];
  }
  const rows: Row[] = [];
  for (const line of readFileSync(input.path, "utf8").split("\n")) {
    if (line.trim().length === 0 || !line.includes(input.marker)) {
      continue;
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      continue;
    }
    const decoded = input.decode(parsed);
    if (decoded._tag === "Some" && decoded.value.runId === input.runId) {
      rows.push(decoded.value);
    }
  }
  return rows;
};

/** The `atm.run` rows for one run, off this check's own ledger file. */
export const runRows = (input: {
  readonly path: string;
  readonly runId: string;
}): LedgerRow[] =>
  ledgerRows({ decode: decodeRunRow, marker: RUN_EVENT_MARKER, ...input });

/** The `atm.sandbox` rows for one run: what the daemon said about its container. */
export const sandboxRows = (input: {
  readonly path: string;
  readonly runId: string;
}) =>
  ledgerRows({
    decode: decodeSandboxRow,
    marker: SANDBOX_EVENT_MARKER,
    ...input,
  });

/**
 * The `atm.turn` rows one run's container wrote about itself, read out of the
 * run's own directory — the ledger the sandbox pointed `EVENT_LOG_DIR` at,
 * which is inside the run mount and therefore on the host.
 */
export const turnRows = (input: {
  readonly dataRoot: string;
  readonly runId: RunId;
}) =>
  ledgerRows({
    decode: decodeTurnRow,
    marker: TURN_EVENT_MARKER,
    path: join(eventLogDirOf(runDirOf(input)), `${TURN_LEDGER_SERVICE}.jsonl`),
    runId: input.runId,
  });

/** What a provider's config directory holds that must never survive the run. */
const CREDENTIAL_NAMES = [".credentials.json", ".claude.json", "auth.json"];

/** What is left in a run's directory once its container and its agent home are gone. */
export interface RunDirEvidence {
  /** Files carrying a provider login. Empty is the only answer that passes. */
  readonly credentials: readonly string[];
  /** Everything still in the run directory, relative to it. */
  readonly entries: readonly string[];
  /** The preserved transcript, or null where no file was copied out. */
  readonly transcript: string | null;
  readonly transcriptPath: string;
}

/**
 * Reads a finished run's directory back.
 *
 * The two claims it answers are about absence and presence in the same place:
 * the conversation the provider wrote is still there, and the credential it sat
 * beside is not. Both are read off the disk after the run, because both are
 * about what a teardown left rather than what the loop said it did.
 */
export const runDirEvidence = (input: {
  readonly dataRoot: string;
  readonly runId: RunId;
}): RunDirEvidence => {
  const runDir = runDirOf(input);
  const transcriptPath = durableTranscriptPathOf(hostRunLayout(input));
  const entries = existsSync(runDir)
    ? readdirSync(runDir, { recursive: true }).map(String)
    : [];
  return {
    credentials: entries.filter((entry) =>
      CREDENTIAL_NAMES.some((name) => entry.includes(name))
    ),
    entries,
    transcript: existsSync(transcriptPath)
      ? readFileSync(transcriptPath, "utf8")
      : null,
    transcriptPath,
  };
};
