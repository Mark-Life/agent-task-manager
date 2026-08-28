/**
 * The shape of the conversation, pinned.
 *
 * The chat reading is only as trustworthy as this plan: a call that loses its
 * result, a log line that escapes its cluster, or an event drawn in the wrong
 * lane all read as "the run did something it did not do". These are the cases a
 * renderer cannot be inspected for by eye — a two-thousand-event run is where
 * they would be found, and by then somebody has already believed one.
 */

import { describe, expect, test } from "bun:test";
import { RUN_EVENT_KINDS, type RunEventKind } from "@workspace/domain";
import {
  buildChatPlan,
  type ChatLane,
  CLAMP_CHARS,
  chatNodeKey,
  laneOf,
  needsClamp,
  shapeOf,
} from "@/features/task/run-chat";
import {
  callOf,
  eventOf,
  logOf,
  PAYLOADS,
  resultOf,
  runOf,
  saidOf,
} from "@/features/task/run-event.fixture";

describe("laneOf", () => {
  test("every kind of event lands in a lane", () => {
    const expected: Record<RunEventKind, ChatLane> = {
      assistant_message: "agent",
      error: "center",
      failed: "center",
      finished: "center",
      log: "center",
      reasoning: "agent",
      started: "center",
      stopped: "center",
      tool_call: "agent",
      tool_result: "agent",
      usage: "center",
    };

    // Driven off the domain's own list rather than off the table above, so a
    // twelfth kind fails here as a missing case instead of being forgotten.
    for (const kind of RUN_EVENT_KINDS) {
      expect(laneOf(eventOf({ payload: PAYLOADS[kind] }))).toBe(expected[kind]);
    }
  });

  test("the model works in one lane and everything else is centred", () => {
    expect(laneOf(eventOf({ payload: saidOf("hello") }))).toBe("agent");
    expect(laneOf(eventOf({ payload: PAYLOADS.usage }))).toBe("center");
  });
});

describe("shapeOf", () => {
  test("a call and a result are different shapes in the same lane", () => {
    expect(shapeOf(eventOf({ payload: callOf("t1") }))).toBe("call");
    expect(shapeOf(eventOf({ payload: resultOf("t1") }))).toBe("result");
    expect(laneOf(eventOf({ payload: callOf("t1") }))).toBe(
      laneOf(eventOf({ payload: resultOf("t1") }))
    );
  });
});

describe("needsClamp", () => {
  test("only long bodies clamp", () => {
    expect(needsClamp(CLAMP_CHARS)).toBe(false);
    expect(needsClamp(CLAMP_CHARS + 1)).toBe(true);
    expect(needsClamp("short".length)).toBe(false);
  });
});

describe("buildChatPlan", () => {
  test("a call and its result become one card", () => {
    const plan = buildChatPlan(runOf([callOf("t1"), resultOf("t1")]));

    expect(plan).toHaveLength(1);
    const [node] = plan;
    if (node?.type !== "pair") {
      throw new Error("expected a pair");
    }
    expect(node.call.payload.callId).toBe("t1");
    expect(node.result.payload.callId).toBe("t1");
  });

  test("a result answers its own call, not the nearest one", () => {
    const plan = buildChatPlan(
      runOf([callOf("t1"), callOf("t2"), resultOf("t2"), resultOf("t1")])
    );

    expect(plan.map((node) => node.type)).toEqual(["pair", "pair"]);
    const [first, second] = plan;
    if (first?.type !== "pair" || second?.type !== "pair") {
      throw new Error("expected two pairs");
    }
    expect(first.call.payload.callId).toBe("t1");
    expect(first.result.seq).toBe(3);
    expect(second.call.payload.callId).toBe("t2");
    expect(second.result.seq).toBe(2);
  });

  test("a call whose result has not arrived reads as unanswered", () => {
    const plan = buildChatPlan(runOf([callOf("t1"), saidOf("still going")]));

    expect(plan.map((node) => node.type)).toEqual(["single", "single"]);
  });

  test("a result whose call is a page back still renders", () => {
    const plan = buildChatPlan(runOf([resultOf("t1")]));

    expect(plan).toHaveLength(1);
    const [node] = plan;
    if (node?.type !== "single") {
      throw new Error("expected a single");
    }
    expect(node.event.payload.kind).toBe("tool_result");
  });

  test("a result is drawn once, inside the card that claimed it", () => {
    const plan = buildChatPlan(
      runOf([callOf("t1"), resultOf("t1"), saidOf("done")])
    );

    expect(plan.map((node) => node.type)).toEqual(["pair", "single"]);
  });

  test("adjacent log lines gather into one cluster", () => {
    const plan = buildChatPlan(
      runOf([
        logOf("pulling"),
        logOf("pulled"),
        logOf("starting"),
        saidOf("hi"),
      ])
    );

    expect(plan.map((node) => node.type)).toEqual(["notes", "single"]);
    const [notes] = plan;
    if (notes?.type !== "notes") {
      throw new Error("expected a cluster");
    }
    expect(notes.events).toHaveLength(3);
  });

  test("anything said between two bursts splits them", () => {
    const plan = buildChatPlan(
      runOf([logOf("one"), saidOf("hello"), logOf("two")])
    );

    expect(plan.map((node) => node.type)).toEqual(["notes", "single", "notes"]);
  });

  test("a result folded into its call does not split the burst around it", () => {
    const plan = buildChatPlan(
      runOf([callOf("t1"), logOf("one"), resultOf("t1"), logOf("two")])
    );

    expect(plan.map((node) => node.type)).toEqual(["pair", "notes"]);
    const [, notes] = plan;
    if (notes?.type !== "notes") {
      throw new Error("expected a cluster");
    }
    expect(notes.events).toHaveLength(2);
  });

  test("an empty run is an empty plan", () => {
    expect(buildChatPlan([])).toEqual([]);
  });
});

describe("chatNodeKey", () => {
  test("a key belongs to an event, so appending renumbers nothing", () => {
    const events = runOf([
      callOf("t1"),
      resultOf("t1"),
      logOf("one"),
      saidOf("hi"),
    ]);
    const before = buildChatPlan(events).map(chatNodeKey);
    const after = buildChatPlan([
      ...events,
      eventOf({ payload: saidOf("more"), seq: 4 }),
    ]).map(chatNodeKey);

    expect(after.slice(0, before.length)).toEqual(before);
  });

  test("every node of a plan is keyed apart from every other", () => {
    const keys = buildChatPlan(
      runOf([
        callOf("t1"),
        resultOf("t1"),
        logOf("one"),
        logOf("two"),
        saidOf("hi"),
        resultOf("orphan"),
      ])
    ).map(chatNodeKey);

    expect(new Set(keys).size).toBe(keys.length);
  });
});
