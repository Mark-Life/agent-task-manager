/**
 * The join between the two halves of a run, asserted where it is pure.
 *
 * Everything here is about arithmetic over a file the host did not write, so it
 * needs no database and no container: what a damaged ledger rolls up to, what a
 * ledger that reported nothing rolls up to, and which of the two sides wins
 * when both have an opinion about the cost.
 */

import { describe, expect, test } from "bun:test";
import { CostUsd, newRunId } from "@workspace/domain";
import { TURN_EVENT_MARKER, TurnEvent } from "@workspace/harness";
import type { RunFinished, RunLost } from "./dispatch-context";
import { lostTerminus } from "./dispatch-context";
import {
  foldTurnRows,
  parseTurnRow,
  runEconomicsOf,
  type TurnRow,
} from "./turn-rollup";

const RUN_ID = newRunId();
const OTHER_RUN_ID = newRunId();

/** A row exactly as `@workspace/telemetry` writes one: the fields, then the stamp. */
const turnLine = (
  overrides: Partial<Parameters<typeof TurnEvent.encode>[0]> & {
    readonly ts: string;
  }
) => {
  const { ts, ...fields } = overrides;
  return JSON.stringify({
    ts,
    ...TurnEvent.encode({
      agentHomeSet: true,
      assistantChars: 10,
      assistantMessages: 1,
      costUsd: null,
      durationMs: null,
      effort: null,
      errorClass: null,
      errorEvents: 0,
      errorMessage: null,
      eventsSeen: 4,
      inputTokens: null,
      model: "claude-opus-5",
      outcome: "done",
      outputTokens: null,
      phase: "end",
      promptChars: 100,
      provider: "claude",
      providerSessionId: "sess-1",
      queueWaitMs: null,
      rateLimitPeakPct: null,
      rateLimitStatus: null,
      rateLimitType: null,
      reasoningChars: 0,
      resumed: false,
      runId: RUN_ID,
      sessionId: null,
      spanId: null,
      subagents: 0,
      taskId: null,
      toolCalls: 2,
      toolErrors: 0,
      totalTokens: null,
      traceId: null,
      turns: null,
      workspaceId: null,
      ...fields,
    }),
    event: TURN_EVENT_MARKER,
    gitSha: "abc1234",
    host: "test-host",
    version: "0.0.1",
  });
};

const rowsOf = (lines: readonly string[]) =>
  lines.map(parseTurnRow).filter((row): row is TurnRow => row !== null);

describe("parseTurnRow", () => {
  test("reads a row the harness really wrote", () => {
    const row = parseTurnRow(turnLine({ ts: "2026-08-01T10:00:00.000Z" }));
    expect(row?.runId).toBe(RUN_ID);
    expect(row?.provider).toBe("claude");
  });

  test("skips a line that is not JSON, because a killed writer leaves one", () => {
    expect(parseTurnRow('{"event":"atm.turn","costU')).toBeNull();
  });

  test("skips another unit of work's row in the same directory", () => {
    expect(parseTurnRow(JSON.stringify({ event: "atm.sandbox" }))).toBeNull();
  });
});

describe("foldTurnRows", () => {
  const lines = [
    turnLine({
      costUsd: 0.01,
      durationMs: 1000,
      toolCalls: 2,
      totalTokens: 100,
      ts: "2026-08-01T10:00:00.000Z",
      turns: 1,
    }),
    turnLine({
      costUsd: 0.02,
      durationMs: 2000,
      toolCalls: 3,
      totalTokens: 200,
      ts: "2026-08-01T10:01:00.000Z",
      turns: 2,
    }),
    turnLine({
      costUsd: 0.03,
      durationMs: 3000,
      model: "claude-sonnet-5",
      toolCalls: 4,
      totalTokens: 300,
      ts: "2026-08-01T10:02:00.000Z",
      turns: 3,
    }),
  ];

  test("adds three turns up into one set of run economics", () => {
    const rollup = foldTurnRows({ rows: rowsOf(lines), runId: RUN_ID });
    expect(rollup.turnCount).toBe(3);
    expect(rollup.costUsd).toBe(CostUsd.make("0.060000"));
    expect(rollup.durationMs).toBe(6000);
    expect(rollup.totalTokens).toBe(600);
    expect(rollup.turns).toBe(6);
    expect(rollup.toolCalls).toBe(9);
  });

  test("takes the last turn's model, in ledger order rather than file order", () => {
    const shuffled = [lines[2], lines[0], lines[1]].filter(
      (line): line is string => line !== undefined
    );
    expect(foldTurnRows({ rows: rowsOf(shuffled), runId: RUN_ID }).model).toBe(
      "claude-sonnet-5"
    );
  });

  test("leaves a neighbouring run's cost out of this run's total", () => {
    const rollup = foldTurnRows({
      rows: rowsOf([
        ...lines,
        turnLine({
          costUsd: 9.99,
          runId: OTHER_RUN_ID,
          ts: "2026-08-01T10:03:00.000Z",
        }),
      ]),
      runId: RUN_ID,
    });
    expect(rollup.turnCount).toBe(3);
    expect(rollup.costUsd).toBe(CostUsd.make("0.060000"));
  });

  test("reports null, not zero, when no turn reported a cost", () => {
    const rollup = foldTurnRows({
      rows: rowsOf([turnLine({ ts: "2026-08-01T10:00:00.000Z" })]),
      runId: RUN_ID,
    });
    expect(rollup.costUsd).toBeNull();
    expect(rollup.totalTokens).toBeNull();
    expect(rollup.turnCount).toBe(1);
  });

  test("a run whose container wrote nothing rolls up to nulls and zeroes", () => {
    const rollup = foldTurnRows({ rows: [], runId: RUN_ID });
    expect(rollup.turnCount).toBe(0);
    expect(rollup.costUsd).toBeNull();
    expect(rollup.toolCalls).toBe(0);
  });
});

describe("runEconomicsOf", () => {
  const rollup = foldTurnRows({
    rows: rowsOf([
      turnLine({
        costUsd: 0.25,
        durationMs: 5000,
        totalTokens: 900,
        ts: "2026-08-01T10:00:00.000Z",
        turns: 4,
      }),
    ]),
    runId: RUN_ID,
  });

  test("fills a lost run's nulls from what its container reported", () => {
    const lost: RunLost = lostTerminus({
      eventsSeen: 2,
      exitCode: null,
      finalText: "",
      providerSessionId: null,
    });
    expect(runEconomicsOf({ rollup, terminus: lost })).toEqual({
      costUsd: CostUsd.make("0.250000"),
      durationMs: 5000,
      totalTokens: 900,
      turns: 4,
    });
  });

  test("leaves a number the host already had alone", () => {
    const finished: RunFinished = {
      costUsd: CostUsd.make("0.100000"),
      durationMs: 1234,
      exitCode: 0,
      finalText: "done",
      kind: "finished",
      providerSessionId: "sess-1",
      totalTokens: 42,
      turns: 1,
    };
    expect(runEconomicsOf({ rollup, terminus: finished })).toEqual({
      costUsd: CostUsd.make("0.100000"),
      durationMs: 1234,
      totalTokens: 42,
      turns: 1,
    });
  });
});
