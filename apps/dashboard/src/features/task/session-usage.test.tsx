/**
 * The three things about this panel that must never regress, because each one
 * is a wrong render that is indistinguishable from a true one.
 *
 * A window nobody could work out must not be drawn as a full or an empty one. A
 * figure the provider does not report must read as unavailable rather than as
 * zero. And a cost must never appear without the word that says it is derived
 * from a price table rather than from a bill.
 *
 * Rendered to static markup rather than through a browser: what is being
 * checked is which words and which elements exist for a given summary, and that
 * is settled by the tree.
 */

import { describe, expect, test } from "bun:test";
import type { AgentSessionUsage } from "@workspace/api";
import {
  AgentSessionId,
  CostUsd,
  type SessionUsage,
  WorkspaceId,
} from "@workspace/domain";
import { DateTime } from "effect";
import { renderToStaticMarkup } from "react-dom/server";
import { SessionUsagePanel } from "@/features/task/session-usage";

/** The bar's own marker, which is what "a percentage was drawn" looks like. */
const BAR = 'data-slot="progress-indicator"';

const SESSION_ID = AgentSessionId.make("019fe144-0e86-7320-a3bd-ccbfdb023c22");

const summary = (overrides: Partial<SessionUsage> = {}): SessionUsage => ({
  computedAt: DateTime.makeUnsafe("2026-08-08T00:00:00Z"),
  contextWindow: 1_000_000,
  contextWindowSource: "inferred",
  cost: {
    pricedRequests: 2,
    priceTableEffective: "2026-08-08",
    priceTableVersion: 1,
    totalUsd: CostUsd.make("0.383881"),
    unpricedModels: [],
    unpricedRequests: 0,
  },
  entries: 5,
  finalContextTokens: 442_693,
  growth: [
    {
      cacheReadTokens: 13_870,
      contextTokens: 24_298,
      inputTokens: 2,
      occurredAt: null,
      outputTokens: 278,
    },
    {
      cacheReadTokens: 439_723,
      contextTokens: 442_693,
      inputTokens: 2,
      occurredAt: null,
      outputTokens: 647,
    },
  ],
  growthSampled: false,
  largestEntries: [],
  models: ["claude-opus-5"],
  peakContextTokens: 442_693,
  provider: "claude",
  requests: 2,
  toolCalls: [{ calls: 2, errors: 0, name: "Bash" }],
  totals: {
    cacheReadTokens: 453_593,
    cacheWriteTokens: 13_394,
    inputTokens: 4,
    outputTokens: 925,
    reasoningOutputTokens: null,
  },
  ...overrides,
});

const markupFor = (usage: AgentSessionUsage | undefined, running = false) =>
  renderToStaticMarkup(<SessionUsagePanel running={running} usage={usage} />);

const rowOf = (usage: SessionUsage): AgentSessionUsage => ({
  sessionId: SESSION_ID,
  usage,
  workspaceId: WorkspaceId.make("workspace"),
});

describe("the context window", () => {
  test("is drawn as a bar with the percentage beside it", () => {
    const markup = markupFor(rowOf(summary()));
    expect(markup).toContain(BAR);
    expect(markup).toContain("44% of 1M");
  });

  test("says when it was looked up rather than reported", () => {
    expect(markupFor(rowOf(summary()))).toContain("window inferred");
    expect(
      markupFor(
        rowOf(
          summary({ contextWindow: 258_400, contextWindowSource: "reported" })
        )
      )
    ).toContain("window reported");
  });

  test("draws no bar at all when nothing can say how big the window is", () => {
    // A bar at zero and a bar nobody could fill look identical and mean the
    // opposite things.
    const markup = markupFor(
      rowOf(summary({ contextWindow: null, contextWindowSource: null }))
    );
    expect(markup).not.toContain(BAR);
    expect(markup).toContain("context window unknown");
  });
});

describe("cost", () => {
  test("never appears without the word that makes it readable", () => {
    expect(markupFor(rowOf(summary()))).toContain("est.");
  });

  test("reads as unavailable when no model in the session could be priced", () => {
    const markup = markupFor(rowOf(summary({ cost: null })));
    expect(markup).toContain("cost unavailable");
    expect(markup).not.toContain("$");
  });
});

describe("a session with nothing recorded", () => {
  test("says so rather than rendering zeros", () => {
    const markup = markupFor(undefined);
    expect(markup).toContain("Nothing recorded yet");
    expect(markup).not.toContain(BAR);
  });
});

describe("a session with a run in flight", () => {
  test("says its figures are as old as the last finished run", () => {
    expect(markupFor(rowOf(summary()), true)).toContain(
      "as of last finished run"
    );
  });
});
