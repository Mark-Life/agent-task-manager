/**
 * What the run knew when it stopped, and the one ending it rewrites.
 *
 * The case worth the file is the quiet one. A worker whose credential expires
 * is never blocked: the tool returns a `401`, the model reads it, says so in
 * prose, and ends its turn — so the provider reports `done` and every row the
 * run writes agrees that it went fine. `terminusWithBoardAccess` is the only
 * thing standing between that and a card showing a successful run that filed
 * nothing, which is exactly what was reported.
 */

import { describe, expect, test } from "bun:test";
import { AGENT_TOOL_PREFIX, describeFailure } from "@workspace/agent-tools";
import { Unauthorized } from "@workspace/api";
import type { AgentEvent } from "@workspace/harness";
import { BOARD_ACCESS_ERROR_CLASS } from "./board-access";
import type { RunTerminus } from "./dispatch-context";
import {
  EMPTY_TURN_PROGRESS,
  observeTurn,
  terminusWithBoardAccess,
} from "./turn-progress";

const COMMENTS_ADD = `${AGENT_TOOL_PREFIX}comments_add`;

const EXPIRED = describeFailure(new Unauthorized({ reason: "token_expired" }));

/** The run's last words, which on this path are a narration of the failure. */
const FINAL_TEXT =
  "I cannot post the task comment — every comments_add call returns Unauthorized.";

const boardCall: AgentEvent = {
  callId: "call-1",
  inputChars: 400,
  kind: "tool_call",
  summary: "post a comment",
  toolName: COMMENTS_ADD,
};

const boardRefused: AgentEvent = {
  callId: "call-1",
  kind: "tool_result",
  ok: false,
  outputChars: EXPIRED.length,
  summary: EXPIRED,
};

const boardAnswered: AgentEvent = {
  callId: "call-1",
  kind: "tool_result",
  ok: true,
  outputChars: 2,
  summary: "ok",
};

/** The terminus a provider that saw nothing wrong hands over. */
const finished: RunTerminus = {
  costUsd: null,
  durationMs: 43_200_000,
  exitCode: 0,
  finalText: FINAL_TEXT,
  kind: "finished",
  providerSessionId: "provider-session-1",
  totalTokens: 900,
  turns: 3,
};

const failed: RunTerminus = {
  costUsd: null,
  durationMs: null,
  errorClass: "OomKilled",
  errorMessage: "the container was killed for memory",
  exitCode: 137,
  finalText: "",
  kind: "failed",
  providerSessionId: null,
  totalTokens: null,
  turns: null,
};

const lost: RunTerminus = {
  costUsd: null,
  durationMs: null,
  eventsSeen: 4,
  exitCode: null,
  finalText: "",
  kind: "lost",
  providerSessionId: null,
  totalTokens: null,
  turns: null,
};

const watch = (events: readonly AgentEvent[]) =>
  events.reduce(observeTurn, EMPTY_TURN_PROGRESS);

describe("observeTurn", () => {
  test("starts a run holding the board", () => {
    expect(EMPTY_TURN_PROGRESS.boardAccess.lost).toBe(false);
  });

  test("carries what the run proved about its board access", () => {
    expect(watch([boardCall, boardRefused]).boardAccess.lost).toBe(true);
    expect(watch([boardCall, boardAnswered]).boardAccess.lost).toBe(false);
  });

  test("does not count a refused comment as a comment posted", () => {
    // The two facts are read together at the close — a run refused on the
    // credential has to still be owed its fallback.
    const progress = watch([boardCall, boardRefused]);
    expect(progress.commentPosted).toBe(false);
  });

  test("still counts the comment a run did post", () => {
    const progress = watch([boardCall, boardAnswered]);
    expect(progress.commentPosted).toBe(true);
    expect(progress.boardAccess.lost).toBe(false);
  });
});

describe("terminusWithBoardAccess", () => {
  test("turns a clean run that could not write into the failure it was", () => {
    const ending = terminusWithBoardAccess({
      progress: watch([boardCall, boardRefused]),
      terminus: finished,
    });

    expect(ending.kind).toBe("failed");
    expect(ending.kind === "failed" && ending.errorClass).toBe(
      BOARD_ACCESS_ERROR_CLASS
    );
    expect(ending.kind === "failed" && ending.errorMessage).toContain(
      "token_expired"
    );
    // What the run measured is not thrown away by being reclassified: it did
    // run for twelve hours and it did cost those tokens.
    expect(ending.durationMs).toBe(43_200_000);
    expect(ending.totalTokens).toBe(900);
    expect(ending.finalText).toBe(FINAL_TEXT);
  });

  test("leaves a run that kept the board exactly as it finished", () => {
    const ending = terminusWithBoardAccess({
      progress: watch([boardCall, boardAnswered]),
      terminus: finished,
    });
    expect(ending).toEqual(finished);
  });

  test("leaves a run that never touched the board alone", () => {
    expect(
      terminusWithBoardAccess({
        progress: EMPTY_TURN_PROGRESS,
        terminus: finished,
      })
    ).toEqual(finished);
  });

  test("does not overwrite a failure that already has a better reason", () => {
    // A container killed for memory also stopped writing to the board. Filing
    // that as a credential problem sends the reader somewhere there is nothing
    // to find.
    const ending = terminusWithBoardAccess({
      progress: watch([boardCall, boardRefused]),
      terminus: failed,
    });
    expect(ending).toEqual(failed);
  });

  test("leaves a lost run lost", () => {
    const ending = terminusWithBoardAccess({
      progress: watch([boardCall, boardRefused]),
      terminus: lost,
    });
    expect(ending).toEqual(lost);
  });
});
