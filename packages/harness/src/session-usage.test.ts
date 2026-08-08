import { describe, expect, test } from "bun:test";
import { DateTime } from "effect";
import { GROWTH_POINT_LIMIT, summarizeSession } from "./session-usage";
import {
  CLAUDE_TRANSCRIPT_LINES,
  CODEX_TRANSCRIPT_LINES,
} from "./testing/transcripts";
import { parseTranscript, type TranscriptUsage } from "./transcript";

const AT = DateTime.makeUnsafe("2026-08-08T00:00:00Z");

/** A reading with everything a Claude one carries, so a case names only what it varies. */
const reading = (
  overrides: Partial<TranscriptUsage> = {}
): TranscriptUsage => ({
  cacheRead: 0,
  cacheWrite: 0,
  cacheWrite1h: 0,
  cacheWrite5m: 0,
  context: 1000,
  contextWindow: null,
  input: 1000,
  line: 0,
  model: "claude-opus-5",
  occurredAt: null,
  output: 100,
  reasoningOutput: null,
  speed: "standard",
  ...overrides,
});

const summarize = (
  usage: readonly TranscriptUsage[],
  entries: Parameters<typeof summarizeSession>[0]["transcript"]["entries"] = []
) =>
  summarizeSession({
    computedAt: AT,
    provider: "claude",
    transcript: { entries, usage },
  });

describe("a claude session, from a real transcript", () => {
  const parsed = parseTranscript("claude", CLAUDE_TRANSCRIPT_LINES);
  const summary = summarizeSession({
    computedAt: AT,
    provider: "claude",
    transcript: parsed,
  });

  test("peaks where the conversation was fullest", () => {
    expect(summary.requests).toBe(2);
    expect(summary.peakContextTokens).toBe(442_693);
    expect(summary.finalContextTokens).toBe(442_693);
  });

  test("infers the window from the model, and says that is what it did", () => {
    expect(summary.contextWindow).toBe(1_000_000);
    expect(summary.contextWindowSource).toBe("inferred");
  });

  test("prices the session against the dated table", () => {
    // Two requests: 4 fresh input, 453,593 cache read, 13,394 one-hour cache
    // writes, 925 output, all on claude-opus-5 at standard speed.
    expect(summary.cost?.pricedRequests).toBe(2);
    expect(summary.cost?.unpricedRequests).toBe(0);
    expect(Number(summary.cost?.totalUsd)).toBeCloseTo(
      (4 * 5 + 453_593 * 0.5 + 13_394 * 10 + 925 * 25) / 1_000_000,
      5
    );
  });

  test("counts the tools and ranks the biggest entries by characters", () => {
    expect(summary.toolCalls).toEqual([{ calls: 2, errors: 0, name: "Bash" }]);
    expect(summary.largestEntries[0]?.chars).toBeGreaterThanOrEqual(
      summary.largestEntries[1]?.chars ?? 0
    );
  });
});

describe("a codex session, from a real rollout", () => {
  const parsed = parseTranscript("codex", CODEX_TRANSCRIPT_LINES);
  const summary = summarizeSession({
    computedAt: AT,
    provider: "codex",
    transcript: parsed,
  });

  test("takes the window the provider reported rather than inferring one", () => {
    expect(summary.contextWindow).toBe(258_400);
    expect(summary.contextWindowSource).toBe("reported");
  });

  test("reports the thinking tokens Claude has no figure for", () => {
    expect(summary.totals.reasoningOutputTokens).toBe(22);
  });

  test("leaves the cost unavailable when the table cannot price the model", () => {
    expect(summary.cost).toBeNull();
  });

  test("counts a tool call the provider marked failed", () => {
    expect(summary.toolCalls).toEqual([{ calls: 1, errors: 0, name: "shell" }]);
  });
});

describe("totals", () => {
  test("stay null for a kind nobody reported", () => {
    const summary = summarize([
      reading({ cacheWrite: null, reasoningOutput: null }),
    ]);
    expect(summary.totals.cacheWriteTokens).toBeNull();
    expect(summary.totals.reasoningOutputTokens).toBeNull();
    expect(summary.totals.inputTokens).toBe(1000);
  });

  test("distinguish a reported zero from a figure nobody wrote", () => {
    const summary = summarize([reading({ cacheWrite: 0 })]);
    expect(summary.totals.cacheWriteTokens).toBe(0);
  });
});

describe("the context window", () => {
  test("is unavailable when nothing can say what the model's is", () => {
    const summary = summarize([reading({ model: "something-new" })]);
    expect(summary.contextWindow).toBeNull();
    expect(summary.contextWindowSource).toBeNull();
  });

  test("is raised past a listing the session has already outgrown", () => {
    // A 200k model observed holding 300k means the listing is wrong, and a
    // gauge pinned at 100% while the session keeps growing tells nobody
    // anything.
    const summary = summarize([
      reading({ context: 300_000, model: "claude-haiku-4-5" }),
    ]);
    expect(summary.contextWindow).toBe(1_000_000);
    expect(summary.contextWindowSource).toBe("inferred");
  });

  test("takes the largest window of a session that switched model", () => {
    const summary = summarize([
      reading({ model: "claude-haiku-4-5" }),
      reading({ model: "claude-opus-5" }),
    ]);
    expect(summary.contextWindow).toBe(1_000_000);
  });
});

describe("cost", () => {
  test("is a floor when some requests used a model the table lacks", () => {
    const summary = summarize([
      reading(),
      reading({ model: "some-future-model" }),
    ]);
    expect(summary.cost?.pricedRequests).toBe(1);
    expect(summary.cost?.unpricedRequests).toBe(1);
    expect(summary.cost?.unpricedModels).toEqual(["some-future-model"]);
  });

  test("charges fast mode at its own rate", () => {
    const standard = summarize([reading({ speed: "standard" })]);
    const fast = summarize([reading({ speed: "fast" })]);
    expect(Number(fast.cost?.totalUsd)).toBeCloseTo(
      Number(standard.cost?.totalUsd) * 2,
      6
    );
  });

  test("prices an unsplit cache write at the cheaper lifetime", () => {
    const summary = summarize([
      reading({
        cacheWrite: 1000,
        cacheWrite1h: null,
        cacheWrite5m: null,
        input: 0,
        output: 0,
      }),
    ]);
    expect(Number(summary.cost?.totalUsd)).toBeCloseTo(
      (1000 * 6.25) / 1_000_000,
      6
    );
  });
});

describe("the growth curve", () => {
  test("is kept whole while it fits", () => {
    const summary = summarize([reading(), reading({ context: 2000 })]);
    expect(summary.growthSampled).toBe(false);
    expect(summary.growth.map((point) => point.contextTokens)).toEqual([
      1000, 2000,
    ]);
  });

  test("is thinned past the limit, keeping the ends and the peak", () => {
    const many = Array.from({ length: GROWTH_POINT_LIMIT * 3 }, (_, index) =>
      reading({ context: index === 700 ? 999_999 : 1000 + index })
    );
    const summary = summarize(many);
    expect(summary.growthSampled).toBe(true);
    expect(summary.growth.length).toBeLessThanOrEqual(GROWTH_POINT_LIMIT + 2);
    expect(summary.growth.at(0)?.contextTokens).toBe(1000);
    expect(summary.growth.at(-1)?.contextTokens).toBe(1000 + many.length - 1);
    expect(
      summary.growth.some((point) => point.contextTokens === 999_999)
    ).toBe(true);
  });
});

describe("a transcript with nothing in it", () => {
  test("summarizes to an answer rather than to zeros that read as measurements", () => {
    const summary = summarize([]);
    expect(summary.requests).toBe(0);
    expect(summary.peakContextTokens).toBeNull();
    expect(summary.finalContextTokens).toBeNull();
    expect(summary.cost).toBeNull();
    expect(summary.totals.outputTokens).toBeNull();
  });
});
