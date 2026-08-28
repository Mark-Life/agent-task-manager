/**
 * The gate's own knobs, read from the environment the way `../config` reads the
 * loop's, and kept apart from it because they answer to a different appetite for
 * risk.
 *
 * Three switches, and the split between the last two is the point.
 *
 * `ENABLED` is the gate itself, reactive floor included: a run that failed on a
 * drained provider pauses the provider. On by default because it costs nothing
 * and only ever fires after a run has already paid.
 *
 * `READ` is whether the providers' own numbers are polled at all. On by default
 * — the read is a passive GET that generates nothing, and it is what puts
 * remaining allowance in front of a person before a wall does. It is also what
 * publishes the reading the dashboard renders, so switching it off blinds the
 * dashboard as well as the gate.
 *
 * `PROACTIVE` is whether a reading may hold a dispatch back. Separate from
 * `READ` because "watch it for a week, then let it act" is a real state an
 * operator wants, and folding the two together makes watching impossible. On by
 * default: both bodies are pinned to captured live responses, and every failure
 * path — no credentials, a 401, a shape that moved — degrades to *unreadable*,
 * which dispatches. What is left to be wrong about is a correct reading held
 * against the threshold below, which is the feature rather than the risk.
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
 * Which providers have an allowance to watch. Not a setting: a knob naming
 * which subscription to watch is a knob that eventually names one, leaving the
 * other to burn tasks against a drained plan with the gate reporting itself as
 * on. What it is instead is a property of the provider, stated per literal so
 * that a fourth harness has to answer the question rather than inherit an
 * answer.
 *
 * Claude and Codex are both a subscription with a published remaining
 * allowance, polled by a passive GET, which is what the whole gate is built on.
 *
 * Pi is not, and excluding it is the honest reading rather than a gap. It runs
 * on the operator's own API key: there is no plan to drain, no endpoint that
 * reports what is left, and the thing it can actually run out of is prepaid
 * credit — which arrives as a refusal on a request and is already classified as
 * `QuotaExhausted` by the harness. Polling it would publish a permanently
 * unreadable column on the dashboard and gate nothing.
 */
const HAS_ALLOWANCE = {
  claude: true,
  codex: true,
  pi: false,
} as const satisfies Record<SessionProvider, boolean>;

/** The providers the gate governs. Derived, so it cannot disagree with the record above. */
export const GATED_PROVIDERS: readonly SessionProvider[] =
  SESSION_PROVIDERS.filter((provider) => HAS_ALLOWANCE[provider]);

/** The gate's settings, resolved from the environment. */
export const quotaConfig = Effect.gen(function* () {
  const enabled = yield* Config.boolean("ORCHESTRATOR_QUOTA_ENABLED").pipe(
    Config.withDefault(true)
  );

  const read = yield* Config.boolean("ORCHESTRATOR_QUOTA_READ").pipe(
    Config.withDefault(true)
  );

  const proactive = yield* Config.boolean("ORCHESTRATOR_QUOTA_PROACTIVE").pipe(
    Config.withDefault(true)
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
    // A reading nobody takes cannot hold anything back, so the pair is resolved
    // here rather than at each of the places that would otherwise have to
    // remember to check both.
    proactive: read && proactive,
    providers: GATED_PROVIDERS,
    read,
    thresholdPercent,
  } as const;
});

/** The resolved gate settings, as {@link quotaConfig} produces them. */
export interface QuotaConfig extends Effect.Success<typeof quotaConfig> {}
