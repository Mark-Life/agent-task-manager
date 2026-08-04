/**
 * The bounded projection of what the gate knows, which is deliberately not what
 * the gate stopped.
 *
 * "How much work did a drain cost us" is counted off the `atm.run` event, beside
 * every other run outcome, so the refusals and the runs stay one series to group
 * by. What is counted here is the part no run row can see: that a pause was set,
 * that a read produced nothing, that the drain matcher had an opinion it could
 * not form, and how full the windows were when somebody looked. A pause has to
 * be countable — "the factory was idle overnight" and "the factory was
 * quota-paused overnight" are different incidents.
 *
 * Every tag is drawn from a `const` tuple, so an unlisted value is a compile
 * error rather than a new time series, and nothing high-cardinality appears: the
 * task a deferral held back is on the wide event, never here.
 */

import { SESSION_PROVIDERS } from "@workspace/domain";
import { boundedCounter, boundedHistogram } from "@workspace/telemetry";
import { QUOTA_WINDOWS } from "./types";

/** Why a usage read produced nothing. `off` is the switch, not a fault. */
const READ_FAILURES = ["off", "unavailable"] as const;

/**
 * Pauses set from a drained run rather than from a read. The number to watch
 * against the proactive gate: a reactive pause means the poller missed a drain
 * that a real run then paid for.
 */
export const quotaReactivePauses = boundedCounter(
  "atm_quota_reactive_pause_total",
  {
    description: "Quota pauses tripped by a drained-run signal",
    tags: { provider: SESSION_PROVIDERS },
  }
);

/**
 * Reads that produced no signal. A gate failing open is dispatching against an
 * unknown allowance, which is a decision worth seeing rather than a silence.
 */
export const quotaReadFailures = boundedCounter("atm_quota_read_errors_total", {
  description: "Usage reads that yielded no signal, so the gate failed open",
  tags: { provider: SESSION_PROVIDERS, reason: READ_FAILURES },
});

/**
 * Errors that looked like a rate limit and matched no anchor. This one only
 * moves when the upstream wording drifts, which is exactly when someone should
 * look at the matcher.
 */
export const quotaCanary = boundedCounter("atm_quota_drain_canary_total", {
  description: "Errors that looked rate-limit-shaped but matched no anchor",
  tags: { provider: SESSION_PROVIDERS },
});

/**
 * Bucket edges crowded at the top, because the interesting readings are the ones
 * near the ceiling: the difference between 90 and 99 decides a deferral, and the
 * difference between 25 and 50 decides nothing.
 */
// biome-ignore lint/style/noMagicNumbers: bucket boundaries are the constant
const UTILIZATION_BUCKETS = [25, 50, 75, 90, 95, 99, 100];

/**
 * How full a window was at each read. A histogram rather than a gauge because
 * the question is "how close to the ceiling do we normally run", which is a
 * distribution — and because a gauge in a process that restarts is a series with
 * holes in it.
 */
export const quotaUtilization = boundedHistogram(
  "atm_quota_window_utilization",
  {
    boundaries: UTILIZATION_BUCKETS,
    description:
      "Utilization percent of a provider's quota window at read time",
    tags: { provider: SESSION_PROVIDERS, window: QUOTA_WINDOWS },
  }
);
