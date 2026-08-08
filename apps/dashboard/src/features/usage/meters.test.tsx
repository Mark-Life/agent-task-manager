/**
 * The one thing about this panel that must never regress: an account nobody
 * could read must not be drawn as an account with nothing left. Everything else
 * here is wording and layout, which a test would only restate — this is the case
 * where a wrong render is indistinguishable from a true one and sends somebody
 * looking for a wall that is not there.
 *
 * Rendered to static markup rather than through a browser: what is being checked
 * is which elements exist for a given reading, and that is settled by the tree.
 */

import { describe, expect, test } from "bun:test";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ProviderUsageSnapshot } from "@workspace/api";
import { DateTime } from "effect";
import { renderToStaticMarkup } from "react-dom/server";
import { keys } from "@/api/keys";
import { UsageMeters } from "@/features/usage/meters";

/** The bar's own marker, which is what "a percentage was drawn" looks like. */
const BAR = 'data-slot="progress-indicator"';

const markupFor = (snapshot: ProviderUsageSnapshot) => {
  const queryClient = new QueryClient();
  queryClient.setQueryData(keys.usage(), snapshot);
  return renderToStaticMarkup(
    <QueryClientProvider client={queryClient}>
      <UsageMeters />
    </QueryClientProvider>
  );
};

describe("UsageMeters", () => {
  test("a document with no providers draws no bar at all", () => {
    const markup = markupFor({ providers: [], publishedAt: null });

    expect(markup).not.toContain(BAR);
    expect(markup).toContain("No reading yet");
  });

  test("a provider that could not be read is a sentence, not an empty tank", () => {
    const markup = markupFor({
      providers: [
        {
          enforced: true,
          note: "the last read produced no signal",
          pausedUntil: null,
          provider: "claude",
          readAt: null,
          state: "unavailable",
          windows: [],
        },
      ],
      publishedAt: DateTime.makeUnsafe("2026-08-07T12:00:00.000Z"),
    });

    expect(markup).not.toContain(BAR);
    expect(markup).toContain("the last read produced no signal");
  });

  test("a real reading draws a bar per window, labelled as the provider labelled it", () => {
    const markup = markupFor({
      providers: [
        {
          enforced: true,
          note: null,
          pausedUntil: null,
          provider: "codex",
          readAt: DateTime.makeUnsafe("2026-08-07T12:00:00.000Z"),
          state: "ok",
          windows: [
            {
              kind: "primary",
              label: "5h",
              remainingPercent: 62,
              resetsAt: null,
              usedPercent: 38,
              windowSeconds: 18_000,
            },
            {
              kind: "secondary",
              label: "7d",
              remainingPercent: 91,
              resetsAt: null,
              usedPercent: 9,
              windowSeconds: 604_800,
            },
          ],
        },
      ],
      publishedAt: DateTime.makeUnsafe("2026-08-07T12:00:00.000Z"),
    });

    expect(markup).toContain("Codex");
    expect(markup).toContain(">5h<");
    expect(markup).toContain(">7d<");
    expect(markup).toContain(">62%<");
  });
});
