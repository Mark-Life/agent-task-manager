/**
 * The memo contract behind a live run that does not flicker.
 *
 * A row that re-renders on every poll is what makes a long run unreadable while
 * it is the one worth reading; a row that *fails* to re-render when its content
 * changed would be worse — a transcript that quietly says the wrong thing. Both
 * directions are pinned here, and both matter: the second is why the comparison
 * is field by field rather than a single equality on an id.
 */

import { describe, expect, test } from "bun:test";
import { RUN_EVENT_KINDS, type RunEventKind } from "@workspace/domain";
import { DateTime } from "effect";
import {
  AT,
  callOf,
  eventOf,
  logOf,
  PAYLOADS,
  type PayloadOf,
  resultOf,
  saidOf,
} from "@/features/task/run-event.fixture";
import {
  sameEvent,
  sameEventCluster,
  sameEventRow,
  samePayload,
  sameToolPair,
} from "@/features/task/run-row";

/**
 * One changed field per kind, in the field that kind's row is mostly about.
 * Typed against the domain's list, so a twelfth kind arrives here without a
 * case and fails to compile rather than going untested.
 */
const CHANGED: { readonly [K in RunEventKind]: PayloadOf<K> } = {
  assistant_message: { ...PAYLOADS.assistant_message, text: "something else" },
  error: { ...PAYLOADS.error, errorMessage: "a different failure" },
  failed: { ...PAYLOADS.failed, exitCode: 1 },
  finished: { ...PAYLOADS.finished, outcome: "timeout" },
  log: { ...PAYLOADS.log, message: "pulled the sandbox image" },
  reasoning: { ...PAYLOADS.reasoning, chars: 12 },
  started: { ...PAYLOADS.started, model: "claude-sonnet-5" },
  stopped: { ...PAYLOADS.stopped, requestedByKind: "manager" },
  tool_call: { ...PAYLOADS.tool_call, summary: "rm -rf nothing" },
  tool_result: { ...PAYLOADS.tool_result, ok: false },
  usage: { ...PAYLOADS.usage, outputTokens: 3 },
};

describe("samePayload", () => {
  test("a payload decoded afresh is still the same payload", () => {
    for (const kind of RUN_EVENT_KINDS) {
      const payload = PAYLOADS[kind];
      const decoded = structuredClone(payload);

      expect(decoded).not.toBe(payload);
      expect(samePayload(payload, decoded)).toBe(true);
    }
  });

  test("every kind notices a change in what it draws", () => {
    for (const kind of RUN_EVENT_KINDS) {
      expect(samePayload(PAYLOADS[kind], CHANGED[kind])).toBe(false);
    }
  });

  test("two kinds are never the same payload", () => {
    expect(samePayload(PAYLOADS.error, PAYLOADS.failed)).toBe(false);
    expect(samePayload(PAYLOADS.tool_call, PAYLOADS.tool_result)).toBe(false);
  });

  test("a message that arrives clipped is not the message that did not", () => {
    const whole = saidOf("the whole thing");

    expect(
      samePayload(whole, { ...whole, originalChars: 9000, truncated: true })
    ).toBe(false);
  });

  test("a call keeps its identity, so a re-used summary is not a re-used call", () => {
    expect(samePayload(callOf("toolu_1"), callOf("toolu_2"))).toBe(false);
  });
});

describe("sameEvent", () => {
  test("a poll that re-decodes the same event redraws nothing", () => {
    const first = eventOf({ payload: saidOf("hello"), seq: 3 });
    const again = eventOf({ payload: saidOf("hello"), seq: 3 });

    expect(again).not.toBe(first);
    expect(sameEvent(first, again)).toBe(true);
  });

  test("the clock is compared as an instant, not as an object", () => {
    const payload = saidOf("hello");
    const later = DateTime.add(AT, { minutes: 1 });

    expect(sameEvent(eventOf({ payload }), eventOf({ at: AT, payload }))).toBe(
      true
    );
    expect(
      sameEvent(eventOf({ payload }), eventOf({ at: later, payload }))
    ).toBe(false);
  });
});

describe("sameToolPair", () => {
  const call = eventOf({ payload: callOf("toolu_1"), seq: 0 });
  const answered = eventOf({ payload: resultOf("toolu_1"), seq: 1 });

  test("a card whose halves both came back unchanged is left alone", () => {
    expect(
      sameToolPair(
        { call, result: answered },
        {
          call: eventOf({ payload: callOf("toolu_1"), seq: 0 }),
          result: eventOf({ payload: resultOf("toolu_1"), seq: 1 }),
        }
      )
    ).toBe(true);
  });

  test("the result arriving on the next poll stops the card reading unanswered", () => {
    expect(
      sameToolPair({ call, result: null }, { call, result: answered })
    ).toBe(false);
  });

  test("a result that turned out to have failed redraws its card", () => {
    expect(
      sameToolPair(
        { call, result: answered },
        {
          call,
          result: eventOf({ payload: resultOf("toolu_1", false), seq: 1 }),
        }
      )
    ).toBe(false);
  });
});

describe("sameEventRow and sameEventCluster", () => {
  test("a row compares the event it draws", () => {
    const event = eventOf({ payload: logOf("one") });

    expect(sameEventRow({ event }, { event: { ...event } })).toBe(true);
    expect(
      sameEventRow({ event }, { event: eventOf({ payload: logOf("two") }) })
    ).toBe(false);
  });

  test("a cluster notices a line appended to it", () => {
    const one = eventOf({ payload: logOf("one"), seq: 0 });
    const two = eventOf({ payload: logOf("two"), seq: 1 });

    expect(
      sameEventCluster({ events: [one, two] }, { events: [one, two] })
    ).toBe(true);
    expect(sameEventCluster({ events: [one] }, { events: [one, two] })).toBe(
      false
    );
  });
});
