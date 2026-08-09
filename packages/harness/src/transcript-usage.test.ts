import { describe, expect, test } from "bun:test";
import {
  CLAUDE_TRANSCRIPT_LINES,
  CODEX_TRANSCRIPT_LINES,
} from "./testing/transcripts";
import { parseTranscript } from "./transcript";

/** A line of a Claude transcript, for the cases the captured file does not hold. */
const claudeLine = (record: unknown) => JSON.stringify(record);

/** An assistant envelope carrying one usage block. */
const assistant = (options: {
  readonly model?: string;
  readonly requestId?: string;
  readonly sidechain?: boolean;
  readonly usage: Record<string, unknown>;
}) =>
  claudeLine({
    isSidechain: options.sidechain ?? false,
    message: {
      content: [{ text: "said", type: "text" }],
      model: options.model ?? "claude-opus-5",
      role: "assistant",
      usage: options.usage,
    },
    requestId: options.requestId ?? "req_1",
    timestamp: "2026-08-04T11:58:07.770Z",
    type: "assistant",
  });

describe("claude usage, from a real transcript", () => {
  const parsed = parseTranscript("claude", CLAUDE_TRANSCRIPT_LINES);

  test("reads one reading per request, not one per line", () => {
    // The captured file holds three assistant lines. Two of them are one
    // request written as two blocks, carrying the same requestId and the same
    // usage — counting lines would report this session's output half again
    // over.
    expect(parsed.usage.length).toBe(2);
    expect(parsed.usage.map((reading) => reading.output)).toEqual([278, 647]);
  });

  test("carries the model, the cache split and the speed tier", () => {
    const [first] = parsed.usage;
    expect(first?.model).toBe("claude-opus-5");
    expect(first?.input).toBe(2);
    expect(first?.cacheRead).toBe(13_870);
    expect(first?.cacheWrite).toBe(10_426);
    // Claude Code writes one-hour cache entries, which cost twice what a
    // five-minute one does. A reader that only had the total would price the
    // whole session at the cheaper rate.
    expect(first?.cacheWrite1h).toBe(10_426);
    expect(first?.cacheWrite5m).toBe(0);
    expect(first?.speed).toBe("standard");
  });

  test("context is what the request put in front of the model", () => {
    expect(parsed.usage.map((reading) => reading.context)).toEqual([
      2 + 13_870 + 10_426,
      2 + 439_723 + 2968,
    ]);
  });

  test("reports no window of its own, because Claude records none", () => {
    expect(
      parsed.usage.every((reading) => reading.contextWindow === null)
    ).toBe(true);
  });
});

describe("claude usage, at the edges", () => {
  test("drops the synthetic messages the SDK writes with an all-zero block", () => {
    const parsed = parseTranscript("claude", [
      assistant({
        model: "<synthetic>",
        usage: {
          cache_creation_input_tokens: 0,
          cache_read_input_tokens: 0,
          input_tokens: 0,
          output_tokens: 0,
        },
      }),
    ]);
    expect(parsed.usage).toEqual([]);
  });

  test("skips a subagent's readings, which belong to its own window", () => {
    const parsed = parseTranscript("claude", [
      assistant({
        sidechain: true,
        usage: { cache_read_input_tokens: 900, input_tokens: 100 },
      }),
    ]);
    expect(parsed.usage).toEqual([]);
  });

  test("keeps unnamed requests apart rather than merging them", () => {
    const lines = [
      assistant({ requestId: "", usage: { input_tokens: 10 } }),
      assistant({ requestId: "", usage: { input_tokens: 20 } }),
    ];
    expect(parseTranscript("claude", lines).usage.map((r) => r.input)).toEqual([
      10, 20,
    ]);
  });

  test("refuses a count that is not one", () => {
    const parsed = parseTranscript("claude", [
      assistant({
        usage: { cache_read_input_tokens: 5, input_tokens: -3 },
      }),
    ]);
    expect(parsed.usage[0]?.input).toBeNull();
    expect(parsed.usage[0]?.context).toBe(5);
  });
});

describe("codex usage, from a real rollout", () => {
  const parsed = parseTranscript("codex", CODEX_TRANSCRIPT_LINES);

  test("reads one reading per model request", () => {
    expect(parsed.usage.length).toBe(2);
    expect(parsed.usage.map((reading) => reading.output)).toEqual([201, 96]);
  });

  test("takes the per-request half, not the running total", () => {
    // The second `token_count` carries a cumulative 32,319 input beside a
    // last-request 18,402. Reading the total would draw a curve that climbs
    // twice as fast as the session did.
    expect(parsed.usage.map((reading) => reading.context)).toEqual([
      13_917, 18_402,
    ]);
  });

  test("splits out fresh input, which Codex folds into its prompt total", () => {
    expect(parsed.usage.map((reading) => reading.input)).toEqual([
      13_917 - 11_648,
      18_402 - 13_900,
    ]);
    expect(parsed.usage.map((reading) => reading.cacheRead)).toEqual([
      11_648, 13_900,
    ]);
  });

  test("reports its own context window, and the model from the turn context", () => {
    expect(parsed.usage.map((reading) => reading.contextWindow)).toEqual([
      258_400, 258_400,
    ]);
    expect(parsed.usage.map((reading) => reading.model)).toEqual([
      "mock-model",
      "mock-model",
    ]);
  });

  test("separates the thinking half of output, which Claude does not", () => {
    expect(parsed.usage.map((reading) => reading.reasoningOutput)).toEqual([
      14, 8,
    ]);
  });

  test("names no speed tier and no cache lifetimes", () => {
    const [first] = parsed.usage;
    expect(first?.speed).toBeNull();
    expect(first?.cacheWrite1h).toBeNull();
    expect(first?.cacheWrite5m).toBeNull();
  });
});

describe("codex usage, at the edges", () => {
  const event = (payload: unknown) =>
    JSON.stringify({ payload, timestamp: "t", type: "event_msg" });

  test("ignores the opening event, which reports nothing", () => {
    const parsed = parseTranscript("codex", [
      event({ info: null, type: "token_count" }),
    ]);
    expect(parsed.usage).toEqual([]);
  });

  test("survives a rollout that never declared a model", () => {
    const parsed = parseTranscript("codex", [
      event({
        info: {
          last_token_usage: { input_tokens: 100, output_tokens: 5 },
          model_context_window: 258_400,
        },
        type: "token_count",
      }),
    ]);
    expect(parsed.usage[0]?.model).toBeNull();
    expect(parsed.usage[0]?.context).toBe(100);
  });
});
