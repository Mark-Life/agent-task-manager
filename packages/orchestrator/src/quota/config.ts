/**
 * The gate's own knobs, read from the environment the way `../config` reads the
 * loop's, and kept apart from it because they answer to a different appetite for
 * risk.
 *
 * Two switches rather than one, and the split is the point. The reactive floor
 * is on by default: it costs nothing, it only ever fires on a run that already
 * failed, and the signal it reads — the provider refusing to serve — is not
 * something to be wrong about. The proactive read is off by default, because it
 * talks to two undocumented endpoints whose bodies are pinned to a captured
 * fixture; until those have been watched against a live account, a gate that
 * defers on a shape it misread would idle a healthy pool with nobody watching.
 * Turning it on is one variable, and the fail-open path means a wrong reading
 * still dispatches.
 */

import { SESSION_PROVIDERS, type SessionProvider } from "@workspace/domain";
import { Config, Effect } from "effect";

/**
 * How full a window may get before dispatch defers. Below 100 on purpose: a run
 * that starts at 99% drains mid-turn and dies with its work half done, which
 * costs more than the deferral does.
 */
const DEFAULT_THRESHOLD_PERCENT = 95;

/**
 * Headroom reserved per in-flight run against a cache that is up to one poll
 * interval stale. Two concurrent runs can move a window several points between
 * reads, and this is what stops the second one being admitted on the first one's
 * numbers.
 */
const DEFAULT_HEADROOM_PERCENT = 5;

/**
 * How long a proactive read is cached. Five minutes is short next to the window
 * it measures — five hours — and long enough that a pass over the board costs
 * one HTTP GET rather than one per task.
 */
const DEFAULT_POLL_INTERVAL_MS = 300_000;

/**
 * How long a reactive pause lasts before the gate probes again, doubling on
 * consecutive re-trips. Fifteen minutes because a drained short window rolls
 * over in hours and the reset the provider reported is not trustworthy enough to
 * honour — see the cooldown note in `./gate`.
 */
const DEFAULT_COOLDOWN_MS = 900_000;

/**
 * The providers the gate governs: both of them, and not a setting. There are two
 * harnesses, both run against a subscription, and a knob naming which of them to
 * watch is a knob that eventually names one — leaving the other to burn tasks
 * against a drained plan with the gate reporting itself as on.
 */
export const GATED_PROVIDERS: readonly SessionProvider[] = [
  ...SESSION_PROVIDERS,
];

/** Where under the data root the pause record lives. */
export const QUOTA_SEGMENT = "quota";

/** The gate's settings, resolved from the environment. */
export const quotaConfig = Effect.gen(function* () {
  const enabled = yield* Config.boolean("ORCHESTRATOR_QUOTA_ENABLED").pipe(
    Config.withDefault(true)
  );

  const proactive = yield* Config.boolean("ORCHESTRATOR_QUOTA_PROACTIVE").pipe(
    Config.withDefault(false)
  );

  const thresholdPercent = yield* Config.int(
    "ORCHESTRATOR_QUOTA_THRESHOLD_PCT"
  ).pipe(Config.withDefault(DEFAULT_THRESHOLD_PERCENT));

  const headroomPercent = yield* Config.int(
    "ORCHESTRATOR_QUOTA_HEADROOM_PCT"
  ).pipe(Config.withDefault(DEFAULT_HEADROOM_PERCENT));

  const pollIntervalMs = yield* Config.int(
    "ORCHESTRATOR_QUOTA_POLL_INTERVAL_MS"
  ).pipe(Config.withDefault(DEFAULT_POLL_INTERVAL_MS));

  const cooldownMs = yield* Config.int("ORCHESTRATOR_QUOTA_COOLDOWN_MS").pipe(
    Config.withDefault(DEFAULT_COOLDOWN_MS)
  );

  return {
    cooldownMs,
    enabled,
    headroomPercent,
    pollIntervalMs,
    proactive,
    providers: GATED_PROVIDERS,
    thresholdPercent,
  } as const;
});

/** The resolved gate settings, as {@link quotaConfig} produces them. */
export interface QuotaConfig extends Effect.Success<typeof quotaConfig> {}
