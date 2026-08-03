/**
 * Whether the loop can tell that a run stopped being able to write.
 *
 * The refusals below are not written out by hand. They are built by putting a
 * real `Unauthorized` — the error the gateway's own `deny` fails with — through
 * `describeFailure`, which is the function the MCP server actually renders a
 * tool failure with. That matters more than it looks: this detector reads text,
 * and a detector tested against text the test invented would keep passing right
 * through the rename that stops it matching anything real. The chain is the
 * assertion.
 *
 * The name of the failing tool is built from `AGENT_TOOL_PREFIX` for the same
 * reason, so `mcp__atm__comments_add` in the reported bug and the string
 * matched here cannot drift apart.
 */

import { describe, expect, test } from "bun:test";
import { AGENT_TOOL_PREFIX, describeFailure } from "@workspace/agent-tools";
import { Unauthorized } from "@workspace/api";
import type { AgentEvent } from "@workspace/harness";
import {
  BOARD_ACCESS_ERROR_CLASS,
  BOARD_ACCESS_HELD,
  boardFailureOf,
  isBoardTool,
  observeBoardAccess,
} from "./board-access";

/** The three board tools the reporting run lost at once. */
const COMMENTS_ADD = `${AGENT_TOOL_PREFIX}comments_add`;
const ARTIFACTS_LIST = `${AGENT_TOOL_PREFIX}artifacts_list`;
const TASKS_MOVE = `${AGENT_TOOL_PREFIX}tasks_move`;

/**
 * What a refused board call reads as by the time it is a tool result: the
 * gateway's error, rendered by the server that serves the tool.
 */
const refusalText = (reason: string) =>
  describeFailure(new Unauthorized({ reason }));

const call = (input: {
  readonly callId: string;
  readonly toolName: string;
}): AgentEvent => ({
  callId: input.callId,
  inputChars: 24,
  kind: "tool_call",
  summary: "a board write",
  toolName: input.toolName,
});

const result = (input: {
  readonly callId: string;
  readonly ok: boolean;
  readonly summary: string;
}): AgentEvent => ({
  callId: input.callId,
  kind: "tool_result",
  ok: input.ok,
  outputChars: input.summary.length,
  summary: input.summary,
});

/** A board call that was refused on the credential, as one call-and-result pair. */
const refused = (input: {
  readonly callId: string;
  readonly reason?: string;
  readonly toolName: string;
}): readonly AgentEvent[] => [
  call({ callId: input.callId, toolName: input.toolName }),
  result({
    callId: input.callId,
    ok: false,
    summary: refusalText(input.reason ?? "token_expired"),
  }),
];

/** A board call that worked. */
const answered = (input: {
  readonly callId: string;
  readonly toolName: string;
}): readonly AgentEvent[] => [
  call(input),
  result({ callId: input.callId, ok: true, summary: "ok" }),
];

/** Folds a whole scripted stream, which is what the run does one event at a time. */
const watch = (events: readonly AgentEvent[]) =>
  events.reduce(observeBoardAccess, BOARD_ACCESS_HELD);

describe("isBoardTool", () => {
  test("knows the board's own tools from everything else the agent holds", () => {
    expect(isBoardTool(COMMENTS_ADD)).toBe(true);
    expect(isBoardTool("Write")).toBe(false);
    expect(isBoardTool("Bash")).toBe(false);
    // A different MCP server on the same run is not the board.
    expect(isBoardTool("mcp__executor__execute")).toBe(false);
  });
});

describe("a run watching its own board calls", () => {
  test("holds the board when it has not called it at all", () => {
    expect(watch([]).lost).toBe(false);
    expect(boardFailureOf(BOARD_ACCESS_HELD)).toBeNull();
  });

  test("holds the board while its calls are answered", () => {
    const access = watch([
      ...answered({ callId: "a", toolName: COMMENTS_ADD }),
      ...answered({ callId: "b", toolName: ARTIFACTS_LIST }),
    ]);
    expect(access.lost).toBe(false);
    expect(access.refusals).toBe(0);
  });

  test("sees the credential go, and says which one and how often", () => {
    const access = watch([
      ...answered({ callId: "a", toolName: ARTIFACTS_LIST }),
      ...refused({ callId: "b", toolName: COMMENTS_ADD }),
      ...refused({ callId: "c", toolName: TASKS_MOVE }),
    ]);

    expect(access.lost).toBe(true);
    expect(access.refusals).toBe(2);
    expect(access.detail).toContain("token_expired");
  });

  test("covers every reason the gateway can refuse a token for", () => {
    // The set is closed and the gateway spells all of them the same way, so a
    // reason added later is caught here rather than the day it happens.
    for (const reason of ["token_expired", "token_bad_signature"]) {
      const access = watch(
        refused({ callId: "a", reason, toolName: COMMENTS_ADD })
      );
      expect(access.lost).toBe(true);
    }
  });

  test("does not read a refused request as a refused credential", () => {
    // The board answered — it said no. The agent asked for a task that is not
    // there, which says nothing at all about whether the next call will land.
    const access = watch([
      ...answered({ callId: "a", toolName: COMMENTS_ADD }),
      call({ callId: "b", toolName: COMMENTS_ADD }),
      result({
        callId: "b",
        ok: false,
        summary: "NotFound: no task with that id in this workspace",
      }),
    ]);

    expect(access.lost).toBe(false);
    expect(access.refusals).toBe(0);
  });

  test("ignores a tool that is not the board's, however it failed", () => {
    const access = watch([
      call({ callId: "a", toolName: "Bash" }),
      result({ callId: "a", ok: false, summary: refusalText("token_expired") }),
    ]);

    expect(access.lost).toBe(false);
    expect(access.refusals).toBe(0);
  });

  test("counts a run that recovered as one that kept the board", () => {
    // One refusal in the middle of a healthy run is not a run that lost the
    // board, and failing it over that would be a worse bug than the one this
    // detector exists for.
    const access = watch([
      ...refused({ callId: "a", toolName: COMMENTS_ADD }),
      ...answered({ callId: "b", toolName: COMMENTS_ADD }),
    ]);

    expect(access.lost).toBe(false);
    // The refusal still happened, and the count still says so.
    expect(access.refusals).toBe(1);
    expect(boardFailureOf(access)).toBeNull();
  });

  test("holds no call it has already seen the result of", () => {
    const access = watch([
      ...answered({ callId: "a", toolName: COMMENTS_ADD }),
      ...refused({ callId: "b", toolName: COMMENTS_ADD }),
    ]);
    expect(access.pending).toEqual([]);
  });
});

describe("boardFailureOf", () => {
  test("names the failure and says what it cost", () => {
    const access = watch([
      ...refused({ callId: "a", toolName: COMMENTS_ADD }),
      ...refused({ callId: "b", toolName: ARTIFACTS_LIST }),
      ...refused({ callId: "c", toolName: TASKS_MOVE }),
    ]);
    const failure = boardFailureOf(access);

    expect(failure?.errorClass).toBe(BOARD_ACCESS_ERROR_CLASS);
    expect(failure?.errorMessage).toContain("could not write to the board");
    expect(failure?.errorMessage).toContain("3 board calls were refused");
    expect(failure?.errorMessage).toContain("token_expired");
    // The reader is told where the run's own words went, because they did
    // survive — this is the sentence that replaces going and asking someone.
    expect(failure?.errorMessage).toContain("artifacts directory");
  });

  test("counts one refusal in the singular, because a person reads it", () => {
    const failure = boardFailureOf(
      watch(refused({ callId: "a", toolName: COMMENTS_ADD }))
    );
    expect(failure?.errorMessage).toContain("1 board call was refused");
  });
});
