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
import { type AgentEvent, Interrupted } from "@workspace/harness";
import { BOARD_ACCESS_ERROR_CLASS } from "./board-access";
import { outcomeOfTerminus, type RunTerminus } from "./dispatch-context";
import {
  EMPTY_TURN_PROGRESS,
  observeTurn,
  terminusOfFailure,
  terminusOfStop,
  terminusWithBoardAccess,
} from "./turn-progress";

const MESSAGES_POST = `${AGENT_TOOL_PREFIX}messages_post`;

const EXPIRED = describeFailure(new Unauthorized({ reason: "token_expired" }));

/** The run's last words, which on this path are a narration of the failure. */
const FINAL_TEXT =
  "I cannot post the task message — every messages_post call returns Unauthorized.";

const boardCall: AgentEvent = {
  callId: "call-1",
  inputChars: 400,
  kind: "tool_call",
  summary: "post a message",
  toolName: MESSAGES_POST,
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
  interruptReason: null,
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

  test("does not count a refused message as a message posted", () => {
    // The two facts are read together at the close — a run refused on the
    // credential has to still be owed its fallback.
    const progress = watch([boardCall, boardRefused]);
    expect(progress.messagePosted).toBe(false);
  });

  test("still counts the message a run did post", () => {
    const progress = watch([boardCall, boardAnswered]);
    expect(progress.messagePosted).toBe(true);
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

describe("terminusOfStop", () => {
  test("names the person who asked, and files it as a stop", () => {
    const ending = terminusOfStop({
      note: { reason: "stopped", requestedBy: "human" },
      progress: watch([boardCall, boardAnswered]),
    });

    expect(ending.kind).toBe("failed");
    // The class every interrupt carries, against the `Unknown` a squashed
    // interrupts-only cause used to produce.
    expect(ending.kind === "failed" && ending.errorClass).toBe("Interrupted");
    expect(ending.kind === "failed" && ending.errorMessage).toBe(
      "stopped by a person"
    );
    expect(ending.kind === "failed" && ending.interruptReason).toBe("stopped");
    expect(outcomeOfTerminus(ending)).toBe("stopped");
  });

  test("tells the manager agent's stop from a person's", () => {
    const ending = terminusOfStop({
      note: { reason: "stopped", requestedBy: "manager" },
      progress: EMPTY_TURN_PROGRESS,
    });
    expect(ending.kind === "failed" && ending.errorMessage).toBe(
      "stopped by the manager agent"
    );
    expect(outcomeOfTerminus(ending)).toBe("stopped");
  });

  test("a shutdown is an interrupt and not somebody's stop", () => {
    // Both are interrupts and neither is a fault; only one of them is a
    // decision, and the outcome column is what separates them.
    const ending = terminusOfStop({
      note: { reason: "shutdown", requestedBy: null },
      progress: EMPTY_TURN_PROGRESS,
    });
    expect(ending.kind === "failed" && ending.errorClass).toBe("Interrupted");
    expect(outcomeOfTerminus(ending)).toBe("interrupted");
  });

  test("says so when nothing recorded who asked", () => {
    // An interrupt from somewhere the loop keeps no note of. Admitting that is
    // the point: the alternative is attributing it to whichever of the three
    // seemed likely.
    const ending = terminusOfStop({
      note: null,
      progress: EMPTY_TURN_PROGRESS,
    });
    expect(ending.kind === "failed" && ending.interruptReason).toBeNull();
    expect(ending.kind === "failed" && ending.errorMessage).toContain(
      "nothing recorded who asked"
    );
    expect(outcomeOfTerminus(ending)).toBe("interrupted");
  });

  test("keeps the run's last words, which are all a killed run leaves", () => {
    const ending = terminusOfStop({
      note: { reason: "stopped", requestedBy: "human" },
      progress: { ...EMPTY_TURN_PROGRESS, finalText: FINAL_TEXT },
    });
    expect(ending.finalText).toBe(FINAL_TEXT);
  });
});

describe("terminusOfFailure", () => {
  test("keeps the reason a typed interrupt already carries", () => {
    // The container's own harness names why it was interrupted. That answer is
    // read off the value rather than matched in the sentence it renders into.
    const ending = terminusOfFailure(
      new Interrupted({ reason: "stopped" }),
      EMPTY_TURN_PROGRESS
    );
    expect(ending.kind === "failed" && ending.interruptReason).toBe("stopped");
    expect(outcomeOfTerminus(ending)).toBe("stopped");
  });

  test("an ordinary failure names no interrupt reason", () => {
    const ending = terminusOfFailure(new Error("the socket died"), {
      ...EMPTY_TURN_PROGRESS,
    });
    expect(ending.kind === "failed" && ending.interruptReason).toBeNull();
  });
});
