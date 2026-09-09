/**
 * The published reading, turned into the handful of strings a sidebar draws.
 *
 * Kept apart from the component because everything that can be wrong here is
 * arithmetic and wording — which window is worst, whether a provider can be
 * drawn at all, how a reset reads twenty minutes before it happens — and none of
 * it needs a browser to be wrong in. The component below it renders this and
 * decides nothing.
 *
 * The one rule the whole file exists to keep: **a provider with no reading is
 * not a provider at zero.** The endpoint answers 200 with an empty list while
 * the loop is down, and a reader that mapped that to bars would draw two drained
 * tanks over an account nobody has looked at. So "could not be read" is a
 * variant here rather than a percentage, and there is no path from it to a bar.
 *
 * Its near neighbour is the second rule: **old figures are not no figures.** A
 * provider whose poll has stopped working still has the last thing it said, and
 * the honest rendering of that is the number with its age — `read 3d ago` — and
 * not a blank. The reading carries two dates for exactly this, so the panel can
 * say when the figures were taken *and* when the loop last looked, and never
 * imply the first from the second.
 */

import type { ProviderUsageSnapshot } from "@workspace/api";
import {
  type ProviderUsageReport,
  SESSION_PROVIDERS,
  type SessionProvider,
  type UsageWindow,
} from "@workspace/domain";
import { DateTime } from "effect";
import { formatRelative } from "@/lib/format";

/** What each harness is called where a person reads it. */
const PROVIDER_NAMES = {
  claude: "Claude",
  codex: "Codex",
  pi: "Pi",
} as const satisfies Record<SessionProvider, string>;

/**
 * Where a window stops being comfortable and starts being a reason to wait.
 *
 * Presentation only. What actually holds a dispatch back is the gate's own
 * threshold, which lives in the loop's environment and is not published — so
 * these bands colour the number rather than claiming to predict it, and the
 * authoritative "this provider is not taking work" signal is the state the
 * reading carries, rendered as words beside the bar.
 */
const DRAINED_PERCENT = 10;
const LOW_PERCENT = 25;

/** How a remaining figure reads at a glance. */
export type UsageTone = "drained" | "healthy" | "low";

const toneOf = (remainingPercent: number): UsageTone => {
  if (remainingPercent <= DRAINED_PERCENT) {
    return "drained";
  }
  return remainingPercent <= LOW_PERCENT ? "low" : "healthy";
};

/** One window, ready to draw. */
export interface WindowView {
  /** Which of the two windows this is. Stable, so a list of them keys off it. */
  readonly kind: UsageWindow["kind"];
  /** The span as the provider stated it — `5h`, `7d` — never a constant of ours. */
  readonly label: string;
  readonly remainingPercent: number;
  /** The same figure as words, for the bar's accessible name and the tooltip. */
  readonly remainingText: string;
  /**
   * How far off the rollover is — `in 42m`, `in 3d`, `now`. Null where the
   * provider reported no reset, which is not the same as one that has passed.
   * Read as `resets ${resetsInText}` wherever it is shown.
   */
  readonly resetsInText: string | null;
  readonly tone: UsageTone;
}

/**
 * One provider's tile.
 *
 * A union rather than a report with optional windows: the unreadable case has no
 * percentage at all and every consumer has to be stopped from inventing one.
 */
export type ProviderView =
  | {
      readonly kind: "readable";
      /** Age of the last look, e.g. `checked 2m ago`. Null before anything looked. */
      readonly attemptText: string | null;
      readonly name: string;
      readonly provider: SessionProvider;
      /** Age of the figures, e.g. `read 3d ago`. Null only on a reading with no date on it. */
      readonly readText: string | null;
      /** The figures outlived the last look, so they are drawn as an old reading. */
      readonly stale: boolean;
      /**
       * Both dates in one line — `read 3d ago · checked just now` — shown only
       * where they differ. Null on a working poll, where the two are the same
       * instant and saying it twice would train the eye to skip the row that
       * matters.
       */
      readonly stalenessText: string | null;
      /** Paused, at its limit, or watched but not enforced. Null when simply fine. */
      readonly statusText: string | null;
      readonly windows: readonly WindowView[];
      /** The lowest remaining figure across the windows — what the rail draws. */
      readonly worst: WindowView;
    }
  | {
      readonly kind: "unreadable";
      readonly attemptText: string | null;
      readonly name: string;
      readonly provider: SessionProvider;
      /** Normally null — nothing was ever read — but set on a reading that named no window. */
      readonly readText: string | null;
      /** Why there is nothing to draw, in the reading's own words where it gave any. */
      readonly reason: string;
    };

/**
 * The whole panel.
 *
 * `blank` is nothing to draw and the sentence saying why: the loop has published
 * nothing — it is not running, or it has not finished a pass — or the read
 * itself failed. Both are a state a reader should see as words, and neither is a
 * provider at zero. It carries the message rather than a code because the
 * caller's two sources of blankness word themselves differently and the panel
 * renders one line either way.
 */
export type UsageView =
  | { readonly kind: "blank"; readonly message: string }
  | {
      readonly kind: "published";
      readonly providers: readonly ProviderView[];
      /**
       * Age of the document itself. The loop rewrites it every sweep whatever
       * it found, so this says the loop is alive and says nothing at all about
       * the figures — which is why it is no longer what the heading shows.
       */
      readonly publishedText: string | null;
      /**
       * Age of the oldest figures on the panel, e.g. `read 3d ago`, or null
       * where nothing has been read on any provider.
       *
       * The heading's number, and the oldest rather than the newest on purpose:
       * a heading is one line for two providers, and the honest summary of "one
       * fresh, one three days old" is three days old. A reader who wants the
       * split has it per provider a few pixels below.
       */
      readonly readingText: string | null;
    };

/** What a reader is told when the loop has published nothing at all. */
export const NOTHING_PUBLISHED =
  "No reading yet — the loop publishes one every few minutes.";

/** The same shape for a read that never arrived, so the panel has one blank state. */
export const blankUsage = (message: string): UsageView => ({
  kind: "blank",
  message,
});

/** What is said about a provider nothing has ever been read from. */
const NO_SIGNAL = "Nothing has been read on this provider yet.";

/**
 * When a window rolls over, said the way it matters.
 *
 * A drained window with twenty minutes on it and one that resets on Thursday are
 * the same percentage and different problems, so the distance is rendered rather
 * than the timestamp. A reset already behind us is a reading that outlived its
 * own window, which is worth saying plainly instead of as a negative distance.
 */
const resetsInTextOf = (window: UsageWindow, now: DateTime.Utc) => {
  if (window.resetsAt === null) {
    return null;
  }
  const due =
    DateTime.toEpochMillis(window.resetsAt) <= DateTime.toEpochMillis(now);
  return due ? "now" : formatRelative(window.resetsAt, now);
};

const windowView = (window: UsageWindow, now: DateTime.Utc): WindowView => ({
  kind: window.kind,
  label: window.label,
  remainingPercent: window.remainingPercent,
  remainingText: `${Math.round(window.remainingPercent)}%`,
  resetsInText: resetsInTextOf(window, now),
  tone: toneOf(window.remainingPercent),
});

/**
 * The state as one short phrase, or nothing.
 *
 * Only the facts a percentage cannot carry: that the gate has stood this
 * provider down, that the provider itself says it is finished, and — the quiet
 * one — that these numbers are being watched but are not allowed to hold
 * anything back. A provider that is simply fine says nothing, because a row of
 * "ok" next to every bar trains the eye to skip the row that is not.
 */
const statusTextOf = (report: ProviderUsageReport, now: DateTime.Utc) => {
  if (report.pausedUntil !== null) {
    return `paused, back ${formatRelative(report.pausedUntil, now)}`;
  }
  if (report.state === "limit_reached") {
    return "limit reached";
  }
  return report.enforced ? null : "not enforced";
};

const readTextOf = (report: ProviderUsageReport, now: DateTime.Utc) =>
  report.readAt === null ? null : `read ${formatRelative(report.readAt, now)}`;

/**
 * When the loop last looked, which is a different fact from when the figures
 * were taken and only interesting where the two differ.
 */
const attemptTextOf = (report: ProviderUsageReport, now: DateTime.Utc) =>
  report.attemptedAt === null
    ? null
    : `checked ${formatRelative(report.attemptedAt, now)}`;

/**
 * The lowest window, which is the one a decision turns on.
 *
 * Ties go to the earlier window in the reading, which is the provider's own
 * order — short window first — so a Claude account with both windows equally
 * spent shows the five-hour one, the one that will bite first.
 */
const worstOf = (windows: readonly WindowView[]) =>
  windows.reduce((worst, window) =>
    window.remainingPercent < worst.remainingPercent ? window : worst
  );

const providerView = (
  report: ProviderUsageReport,
  now: DateTime.Utc
): ProviderView => {
  const name = PROVIDER_NAMES[report.provider];
  const attemptText = attemptTextOf(report, now);
  const readText = readTextOf(report, now);

  // Both halves of the guard matter. `unavailable` is a provider nothing has
  // ever been read from; an empty window list is a reading that decoded but
  // described no window, which is the same absence arriving by a different
  // route. A read that has *stopped* working is neither — it has figures, and
  // it falls through to the readable branch carrying their age.
  if (report.state === "unavailable" || report.windows.length === 0) {
    return {
      attemptText,
      kind: "unreadable",
      name,
      provider: report.provider,
      readText,
      reason: report.note ?? NO_SIGNAL,
    };
  }

  const windows = report.windows.map((window) => windowView(window, now));
  return {
    attemptText,
    kind: "readable",
    name,
    provider: report.provider,
    readText,
    stale: report.stale,
    stalenessText: report.stale
      ? [readText, attemptText].filter((part) => part !== null).join(" · ")
      : null,
    statusText: statusTextOf(report, now),
    windows,
    worst: worstOf(windows),
  };
};

/** Canonical order, so the two bars on the collapsed rail never swap places. */
const providerOrder = (provider: SessionProvider) =>
  SESSION_PROVIDERS.indexOf(provider);

/**
 * The oldest set of figures on the panel, as the heading says it.
 *
 * Off the reports rather than off the views, because the comparison is between
 * instants and the views carry only the words. Null where no provider has ever
 * been read, which is the one case the heading has no age to show.
 */
const oldestReadingText = (
  reports: readonly ProviderUsageReport[],
  now: DateTime.Utc
) => {
  let oldest: DateTime.Utc | null = null;
  for (const report of reports) {
    if (
      report.readAt !== null &&
      (oldest === null ||
        DateTime.toEpochMillis(report.readAt) < DateTime.toEpochMillis(oldest))
    ) {
      oldest = report.readAt;
    }
  }
  return oldest === null ? null : `read ${formatRelative(oldest, now)}`;
};

/** The published reading as the sidebar needs it. */
export const usageView = (
  snapshot: ProviderUsageSnapshot,
  now: DateTime.Utc
): UsageView => {
  if (snapshot.providers.length === 0) {
    return blankUsage(NOTHING_PUBLISHED);
  }
  return {
    kind: "published",
    providers: [...snapshot.providers]
      .sort((a, b) => providerOrder(a.provider) - providerOrder(b.provider))
      .map((report) => providerView(report, now)),
    publishedText:
      snapshot.publishedAt === null
        ? null
        : formatRelative(snapshot.publishedAt, now),
    readingText: oldestReadingText(snapshot.providers, now),
  };
};

/**
 * The whole reading as one line of text.
 *
 * The collapsed rail is two bars and no words, so this is the accessible name
 * that stands in for them — a screen reader gets the same facts a sighted reader
 * gets from hovering, rather than "progressbar, 62".
 */
export const usageSummary = (view: UsageView) => {
  if (view.kind === "blank") {
    return `Provider usage: ${view.message}`;
  }
  const parts = view.providers.map((provider) => {
    if (provider.kind === "unreadable") {
      return `${provider.name} has not been read`;
    }
    const figures = provider.windows
      .map((window) => `${window.label} ${window.remainingText} left`)
      .join(", ");
    // The age rides along only when the figures outlived the last look. On a
    // working poll it is noise; on a broken one it is the whole message, and a
    // screen reader hearing the percentages alone would hear them as current.
    return provider.stale && provider.readText !== null
      ? `${provider.name} ${figures}, ${provider.readText}`
      : `${provider.name} ${figures}`;
  });
  return `Provider usage: ${parts.join("; ")}`;
};
