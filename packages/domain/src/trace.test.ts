import { describe, expect, test } from "bun:test";
import { formatTraceparent, parseTraceparent, traceparentOf } from "./trace";

const TRACE_ID = "4bf92f3577b34da6a3ce929d0e0e4736";
const SPAN_ID = "00f067aa0ba902b7";
const HEADER = `00-${TRACE_ID}-${SPAN_ID}-01`;

describe("parseTraceparent", () => {
  test("reads the ids and the sampled bit off a real header", () => {
    expect(parseTraceparent(HEADER)).toEqual({
      sampled: true,
      spanId: SPAN_ID,
      traceId: TRACE_ID,
    });
  });

  test("reads an unsampled header as unsampled", () => {
    expect(parseTraceparent(`00-${TRACE_ID}-${SPAN_ID}-00`)?.sampled).toBe(
      false
    );
  });

  test("takes the low bit of the flags byte, not the whole byte", () => {
    expect(parseTraceparent(`00-${TRACE_ID}-${SPAN_ID}-03`)?.sampled).toBe(
      true
    );
    expect(parseTraceparent(`00-${TRACE_ID}-${SPAN_ID}-02`)?.sampled).toBe(
      false
    );
  });

  test("tolerates surrounding whitespace, as a header value carries", () => {
    expect(parseTraceparent(`  ${HEADER}\n`)?.traceId).toBe(TRACE_ID);
  });

  test.each([
    ["absent", null],
    ["undefined", undefined],
    ["blank", ""],
    ["not a header at all", "hello"],
    ["three fields", `00-${TRACE_ID}-${SPAN_ID}`],
    ["five fields", `${HEADER}-extra`],
    ["a short trace id", `00-${TRACE_ID.slice(1)}-${SPAN_ID}-01`],
    ["a short span id", `00-${TRACE_ID}-${SPAN_ID.slice(1)}-01`],
    ["uppercase hex", HEADER.toUpperCase()],
    ["a non-hex digit", `00-${TRACE_ID.replace("4", "z")}-${SPAN_ID}-01`],
    ["the reserved ff version", `ff-${TRACE_ID}-${SPAN_ID}-01`],
    ["a zeroed trace id", `00-${"0".repeat(32)}-${SPAN_ID}-01`],
    ["a zeroed span id", `00-${TRACE_ID}-${"0".repeat(16)}-01`],
  ])("answers null for %s", (_name, header) => {
    expect(parseTraceparent(header)).toBeNull();
  });
});

describe("formatTraceparent", () => {
  test("round-trips through the parser", () => {
    const context = { sampled: true, spanId: SPAN_ID, traceId: TRACE_ID };
    expect(formatTraceparent(context)).toBe(HEADER);
    expect(parseTraceparent(formatTraceparent(context))).toEqual(context);
  });

  test("writes the unsampled flag so the far side does not export it", () => {
    expect(
      formatTraceparent({ sampled: false, spanId: SPAN_ID, traceId: TRACE_ID })
    ).toBe(`00-${TRACE_ID}-${SPAN_ID}-00`);
  });
});

describe("traceparentOf", () => {
  test("is null outside a trace, where either id is missing", () => {
    expect(traceparentOf({ spanId: SPAN_ID, traceId: null })).toBeNull();
    expect(traceparentOf({ spanId: null, traceId: TRACE_ID })).toBeNull();
  });

  test("defaults to sampled, because a caller that did not say meant keep it", () => {
    expect(traceparentOf({ spanId: SPAN_ID, traceId: TRACE_ID })).toBe(HEADER);
  });
});
