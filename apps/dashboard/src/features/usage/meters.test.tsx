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
          attemptedAt: DateTime.makeUnsafe("2026-08-07T12:00:00.000Z"),
          enforced: true,
          note: "nothing has been read on this provider yet",
          pausedUntil: null,
          provider: "claude",
          readAt: null,
          stale: false,
          state: "unavailable",
          windows: [],
        },
      ],
      publishedAt: DateTime.makeUnsafe("2026-08-07T12:00:00.000Z"),
    });

    expect(markup).not.toContain(BAR);
    expect(markup).toContain("nothing has been read on this provider yet");
  });

  test("a real reading draws a bar per window, labelled as the provider labelled it", () => {
    const markup = markupFor({
      providers: [
        {
          attemptedAt: DateTime.makeUnsafe("2026-08-07T12:00:00.000Z"),
          enforced: true,
          note: null,
          pausedUntil: null,
          provider: "codex",
          readAt: DateTime.makeUnsafe("2026-08-07T12:00:00.000Z"),
          stale: false,
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

  /**
   * The other half of the rule at the top of this file. An account that *was*
   * read and has stopped being readable must not be drawn as an account nobody
   * has ever looked at: the figures are the last true thing anyone knows about
   * it, and blanking them sends somebody looking for a login that is fine.
   */
  test("figures older than the last look are still drawn, marked and dated", () => {
    const markup = markupFor({
      providers: [
        {
          attemptedAt: DateTime.nowUnsafe(),
          enforced: true,
          note: "the last read produced no signal — these figures are the last that did",
          pausedUntil: null,
          provider: "codex",
          readAt: DateTime.makeUnsafe(
            DateTime.toEpochMillis(DateTime.nowUnsafe()) - 3 * 86_400_000
          ),
          stale: true,
          state: "ok",
          windows: [
            {
              kind: "primary",
              label: "5h",
              remainingPercent: 40,
              resetsAt: null,
              usedPercent: 60,
              windowSeconds: 18_000,
            },
          ],
        },
      ],
      publishedAt: DateTime.nowUnsafe(),
    });

    expect(markup).toContain(BAR);
    expect(markup).toContain(">40%<");
    // The age of the figures, and the marker that says they are being drawn as
    // old rather than as current.
    expect(markup).toContain("read 3d ago");
    expect(markup).toContain('data-stale="true"');
    // And the heading is the age of the reading, not of the document, which the
    // loop rewrote a moment ago.
    expect(markup).not.toContain(">just now<");
  });
});
