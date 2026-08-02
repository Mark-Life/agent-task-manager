/**
 * What the stuck scan is tuned by.
 *
 * The thresholds live here rather than in the rule because a heuristic whose
 * numbers are literals in its own detection code is one nobody can retune when
 * a fleet turns out to be chattier or slower than the one it was written
 * against. Every default is a named constant, mirrored in `.env.example` and
 * `@workspace/env`, and every one is left unset there — an empty value reads as
 * unset to `Config` and as an empty string to a shell.
 */

import { Config, Effect } from "effect";
import type { StuckThresholds } from "./rule";

/** How often live runs are looked at. Slow on purpose: nothing here is urgent. */
export const DEFAULT_STUCK_SCAN_INTERVAL_MS = 60_000;

/** The trailing window the rule judges, and the age a run is spared below. */
export const DEFAULT_STUCK_WINDOW_MINUTES = 10;

/** Below this many calls in the window, a run is quiet rather than spinning. */
export const DEFAULT_STUCK_MIN_TOOL_CALLS = 6;

/** At or below this many distinct signatures, a run is repeating itself. */
export const DEFAULT_STUCK_DISTINCT_SIGNATURES = 2;

/**
 * How many windows of tool calls the scan keeps per run.
 *
 * More than one, so that a file edit just before the window still dates how
 * long the run has looked stuck. Bounded, because this is a read buffer over
 * `run_event` and not a second record of what happened.
 */
export const STUCK_RETAINED_WINDOWS = 2;

/** How many events one run's catch-up read takes per page. */
export const STUCK_EVENT_PAGE = 500;

/**
 * How many pages one run's catch-up read takes per tick. A run that has said
 * more than this since the last tick is read the rest of the way on the next
 * one, which costs latency and never memory.
 */
export const STUCK_EVENT_PAGES = 8;

/** The scan's settings, read once at layer build. */
export const stuckConfig = Effect.gen(function* () {
  const scanIntervalMs = yield* Config.int("STUCK_SCAN_INTERVAL_MS").pipe(
    Config.withDefault(DEFAULT_STUCK_SCAN_INTERVAL_MS)
  );
  const windowMinutes = yield* Config.int("STUCK_WINDOW_MINUTES").pipe(
    Config.withDefault(DEFAULT_STUCK_WINDOW_MINUTES)
  );
  const minToolCalls = yield* Config.int("STUCK_MIN_TOOL_CALLS").pipe(
    Config.withDefault(DEFAULT_STUCK_MIN_TOOL_CALLS)
  );
  const distinctSignatures = yield* Config.int(
    "STUCK_DISTINCT_SIGNATURES"
  ).pipe(Config.withDefault(DEFAULT_STUCK_DISTINCT_SIGNATURES));

  return {
    scanIntervalMs,
    thresholds: {
      distinctSignatures,
      minToolCalls,
      windowMinutes,
    } satisfies StuckThresholds,
  } as const;
});

/** The settings, derived so a reader of them cannot restate the shape. */
export interface StuckConfig extends Effect.Success<typeof stuckConfig> {}
