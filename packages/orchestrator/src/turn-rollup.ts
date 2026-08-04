/**
 * The `atm.turn` rows a container wrote, rolled up into the numbers the host
 * reports for the run. Pure — nothing here touches a disk, a database or a
 * clock.
 *
 * The two sides of a run measure different things and neither can answer for
 * the other. The host knows when the container started, when it stopped and
 * what it exited with; the model's cost, its token counts and how many turns it
 * took are known only inside, where the provider answered. So the container
 * writes its own wide event to a directory that is a mount, the host reads the
 * file back after teardown, and the two join on `runId` — which the orchestrator
 * minted and passed in as an environment variable. That is the whole mechanism,
 * and it is why one `GROUP BY` can ask a question about both halves.
 *
 * Reading is total over a damaged file. A line that is not JSON, a row from
 * another service's ledger, a row for another run, a row the schema has moved on
 * from: each is skipped rather than failing the read, because the file is
 * appended to by a process that can be killed mid-write and a partially
 * readable ledger is the normal state of exactly the run worth investigating.
 *
 * Nothing here fabricates a number. A sum skips the rows that reported nothing
 * and stays null when none of them did, so a run whose container died before
 * the provider answered rolls up to `null` rather than to `0` — a zero is a
 * number somebody later averages, and it would make the runs that cost nothing
 * because they failed indistinguishable from the ones that were cheap.
 */

import { CostUsd, type RunId } from "@workspace/domain";
import { TURN_EVENT_MARKER, TurnEvent } from "@workspace/harness";
import { Option, Schema } from "effect";
import type { RunTerminus } from "./dispatch-context";

/**
 * One `atm.turn` row as the harness declares it. Derived from the harness's own
 * schema rather than restated, so a field the harness adds is readable here
 * without a second definition to keep in step.
 */
export type TurnRow = typeof TurnEvent.rowSchema.Type;

const decodeTurnRow = Schema.decodeUnknownOption(TurnEvent.rowSchema);

/**
 * Decimals kept when the per-turn costs are added up.
 *
 * The roll-up is already one conversion away from the exact decimal the domain
 * carries: a wide event stores `costUsd` as a JSON number, so the ledger has
 * float-grade values by the time the host reads them. Six decimals is finer
 * than any provider's per-turn price and keeps the result inside the pattern
 * {@link CostUsd} checks; the exact per-turn figures stay on the run's own rows.
 */
const COST_DECIMALS = 6;

/** One line of a ledger file, or nothing where it is not JSON at all. */
const parseJson = (line: string): unknown => {
  try {
    return JSON.parse(line);
  } catch {
    return null;
  }
};

/** The marker a row declares itself with, when it declares one. */
const markerOf = (value: unknown) => {
  const marker = (value as { readonly event?: unknown } | null)?.event;
  return typeof marker === "string" ? marker : null;
};

/**
 * One `atm.turn` row, or null for anything else on the line.
 *
 * The marker is checked before the schema runs, which is both cheaper and
 * clearer: the same directory holds every service's ledger, so most lines are
 * some other unit of work's and rejecting them by tag says so, where a schema
 * failure would read as a broken row.
 */
export const parseTurnRow = (line: string): TurnRow | null => {
  const parsed = parseJson(line);
  if (parsed === null || markerOf(parsed) !== TURN_EVENT_MARKER) {
    return null;
  }
  return Option.getOrNull(decodeTurnRow(parsed));
};

/**
 * What a run's container reported about itself, across all the turns it took.
 *
 * Every field names a question the host cannot answer on its own: what the run
 * cost, how many turns it needed, how close the provider came to its rate
 * limit, whether the conversation it continued has an id to resume. The counts
 * are honest zeros — a run with no rows really did make no tool calls — while
 * the economics are honest nulls.
 */
export interface TurnRollup {
  /** Characters of assistant text across the run. Measured; the text is in the transcript. */
  readonly assistantChars: number;
  readonly costUsd: CostUsd | null;
  /** Time inside the provider, summed. Shorter than the container's wall clock. */
  readonly durationMs: number | null;
  /** The last failing turn's classification, in the harness's vocabulary. */
  readonly errorClass: string | null;
  readonly errorMessage: string | null;
  /** Normalized events the turns produced. Tells a silent provider from a dead one. */
  readonly eventsSeen: number;
  /** What the provider actually chose, which is not always what was asked for. */
  readonly model: string | null;
  /** How the last turn ended, in the harness's wider outcome union. */
  readonly outcome: string | null;
  /** The provider's conversation id, which is what a resume is pointed at. */
  readonly providerSessionId: string | null;
  /** Highest utilization any turn reported, 0–100. What the quota gate watches. */
  readonly rateLimitPeakPct: number | null;
  /** The worst reading seen, not the last: a warning that later cleared still happened. */
  readonly rateLimitStatus: string | null;
  readonly reasoningChars: number;
  readonly subagents: number;
  readonly toolCalls: number;
  readonly toolErrors: number;
  readonly totalTokens: number | null;
  /** How many `atm.turn` rows the run left. Zero means the container wrote nothing back. */
  readonly turnCount: number;
  readonly turns: number | null;
}

/** A run whose container reported nothing at all. */
export const EMPTY_TURN_ROLLUP: TurnRollup = {
  assistantChars: 0,
  costUsd: null,
  durationMs: null,
  errorClass: null,
  errorMessage: null,
  eventsSeen: 0,
  model: null,
  outcome: null,
  providerSessionId: null,
  rateLimitPeakPct: null,
  rateLimitStatus: null,
  reasoningChars: 0,
  subagents: 0,
  toolCalls: 0,
  toolErrors: 0,
  totalTokens: null,
  turnCount: 0,
  turns: null,
};

/**
 * Adds a reading to a running total, leaving the total null until something
 * reports. A turn that produced no number contributes nothing rather than a
 * zero, so a run where one turn answered and two did not reports the one real
 * figure instead of pretending the other two were free.
 */
const addReported = (total: number | null, next: number | null) =>
  next === null ? total : (total ?? 0) + next;

/** Keeps the larger reading, treating an absent one as no reading at all. */
const peak = (current: number | null, next: number | null) => {
  if (current === null || next === null) {
    return next ?? current;
  }
  return Math.max(current, next);
};

/** Keeps whichever value is present, preferring the newer one. */
const latest = <A>(current: A | null, next: A | null) => next ?? current;

/** How bad each rate-limit reading is, so a run keeps the worst one it saw. */
const RATE_LIMIT_SEVERITY: Readonly<Record<string, number>> = {
  allowed: 0,
  allowed_warning: 1,
  rejected: 2,
};

const worstRateLimit = (current: string | null, next: string | null) => {
  if (current === null || next === null) {
    return next ?? current;
  }
  return (RATE_LIMIT_SEVERITY[next] ?? 0) > (RATE_LIMIT_SEVERITY[current] ?? 0)
    ? next
    : current;
};

/** The accumulator, with the cost kept as a float until the last step. */
interface Accumulator extends Omit<TurnRollup, "costUsd"> {
  readonly costTotal: number | null;
}

const foldRow = (accumulated: Accumulator, row: TurnRow): Accumulator => ({
  assistantChars: accumulated.assistantChars + row.assistantChars,
  costTotal: addReported(accumulated.costTotal, row.costUsd),
  durationMs: addReported(accumulated.durationMs, row.durationMs),
  // The classification of the last turn that named one: a run whose first turn
  // failed and whose retry succeeded ended well, and the row that says so is
  // the later one.
  errorClass: latest(accumulated.errorClass, row.errorClass),
  errorMessage: latest(accumulated.errorMessage, row.errorMessage),
  eventsSeen: accumulated.eventsSeen + row.eventsSeen,
  model: latest(accumulated.model, row.model),
  outcome: latest(accumulated.outcome, row.outcome),
  providerSessionId: latest(
    accumulated.providerSessionId,
    row.providerSessionId
  ),
  rateLimitPeakPct: peak(accumulated.rateLimitPeakPct, row.rateLimitPeakPct),
  rateLimitStatus: worstRateLimit(
    accumulated.rateLimitStatus,
    row.rateLimitStatus
  ),
  reasoningChars: accumulated.reasoningChars + row.reasoningChars,
  subagents: accumulated.subagents + row.subagents,
  toolCalls: accumulated.toolCalls + row.toolCalls,
  toolErrors: accumulated.toolErrors + row.toolErrors,
  totalTokens: addReported(accumulated.totalTokens, row.totalTokens),
  turnCount: accumulated.turnCount + 1,
  turns: addReported(accumulated.turns, row.turns),
});

/** Which run's rows, out of everything the ledger directory holds. */
export interface TurnFoldInput {
  readonly rows: readonly TurnRow[];
  readonly runId: RunId;
}

/**
 * Rolls a run's turn rows up into the numbers the run row and the `atm.run`
 * event carry.
 *
 * Rows are folded oldest first, by the ledger's own `ts`, so "the last turn's
 * model" is the same answer whichever order the files came back in — a
 * directory listing is not a chronology, and a run that switched provider
 * mid-way would otherwise report whichever row the filesystem happened to hand
 * over last.
 *
 * The `runId` filter is the join, not a formality. The ledger directory is
 * per-run today, and the day it is not, a row from a neighbouring run silently
 * added to this one's cost is a bug nobody would ever see.
 */
export const foldTurnRows = (input: TurnFoldInput): TurnRollup => {
  // `filter` already produced a fresh array, so sorting it in place mutates
  // nothing the caller can see.
  const mine = input.rows
    .filter((row) => row.runId === input.runId)
    .sort((left, right) => left.ts.localeCompare(right.ts));
  const { costTotal, ...rest } = mine.reduce(foldRow, {
    ...EMPTY_TURN_ROLLUP,
    costTotal: null,
  });
  return {
    ...rest,
    costUsd:
      costTotal === null
        ? null
        : CostUsd.make(costTotal.toFixed(COST_DECIMALS)),
  };
};

/** A terminus and what the container said about the same run. */
export interface RunEconomicsInput {
  readonly rollup: TurnRollup;
  readonly terminus: RunTerminus;
}

/**
 * The economics the run row records: what the host observed, with each gap
 * filled from what the container reported.
 *
 * Filling rather than overriding, and only where the host has nothing. A
 * terminus that carries a cost read it off the terminal event, which is the
 * provider's own final roll-up for that turn and the more direct answer; a
 * terminus that carries `null` either never saw a terminal event or was a
 * `lost` run, and both nulled their economics precisely because the host heard
 * nothing. Reading a figure the container really wrote is not fabricating one —
 * it is the whole reason the ledger rides out on a mount — so a run the loop
 * lost still reports what it actually spent.
 */
export const runEconomicsOf = (input: RunEconomicsInput) => ({
  costUsd: input.terminus.costUsd ?? input.rollup.costUsd,
  durationMs: input.terminus.durationMs ?? input.rollup.durationMs,
  totalTokens: input.terminus.totalTokens ?? input.rollup.totalTokens,
  turns: input.terminus.turns ?? input.rollup.turns,
});
