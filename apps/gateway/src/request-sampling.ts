/**
 * Which finished requests reach the ledger, and what each kept row weighs.
 *
 * The gateway is the one unit of work in this system whose volume is a function
 * of a screen being open rather than of work being done. A dashboard on a second
 * monitor asks `/tasks/board` every ten seconds and `/tasks/:taskId` once per
 * card in progress, forever, and those two routes were 69.7% of the ledger the
 * day this was written — 10,944 rows of 15,695, 92.9% of them a 200 answered in
 * a couple of dozen milliseconds. That is the tenfold rise
 * `@workspace/telemetry`'s rotation comment names as the trigger for a
 * predicate, so here it is.
 *
 * **The decision is made after the outcome is known.** Sampling at the front
 * door throws away the request that explains the outage; deciding at the tail
 * keeps everything interesting and thins only the remainder. Three things are
 * interesting and are kept whole:
 *
 * - **Any ending but `done`** — an error, a refusal, a client that hung up.
 *   These are what the ledger exists for and they are already rare.
 * - **Anything above this route's own p99** — per route, because `/tasks/board`
 *   is inherently slower than `/health` and one global threshold would keep
 *   every board read and no health outlier. {@link tailThresholdOf} is that
 *   threshold, and it moves with the traffic rather than being a number written
 *   here that rots the way the rotation comment did.
 * - **Every event stream**, which is rare, long-lived, and the only row
 *   `streamHeldMs` is on. A leaked connection is a thing you find in one row or
 *   not at all, and thinning them makes the gauge's story unverifiable.
 *
 * **What is left carries its weight.** The remainder is kept one in
 * {@link DEFAULT_SAMPLE_ONE_IN} and stamped `sampleRate` with that figure, so
 * `SUM(sampleRate)` over the ledger is the traffic and not the sample. The turn
 * is a counter rather than a coin, and per route: at this volume a 5% coin can
 * leave a route unrepresented for an hour, and a counter makes the stamped
 * weight exact rather than an expectation. Requests kept for cause weigh 1 —
 * they stand for themselves.
 *
 * **The counters sit above all of this**, in `./request-event`'s single emit
 * site: `atm_requests_total` and `atm_request_duration_ms` describe every
 * request the gateway answers, and only the stored rows are a sample. A query
 * that needs an exact count of anything bounded has the metric to read.
 *
 * **What this buys.** 2,569 rows/day at 772 B/row filled the 64 MiB cap in 34
 * days. Keeping every non-`done` row, the 1% above p99 and one in twenty of the
 * rest leaves roughly 6% of the traffic plus the failures — on the order of 160
 * rows and 124 KB a day, so the live file turns over in about eighteen months
 * and the two generations kept span years. Set `GATEWAY_SAMPLE_ONE_IN=1` to
 * turn the thinning off and keep every row; the tail and outcome rules then
 * change nothing, since they only ever add.
 */

import { Config, Effect, Ref } from "effect";
import type { FinishedRequest } from "./request-event";
import { DURATION_MS_BOUNDARIES, routeTag } from "./request-metrics";

/** One in this many otherwise unremarkable requests is kept. */
const DEFAULT_SAMPLE_ONE_IN = 20;

/** One in one is every one: the value that turns the thinning off. */
const KEEP_EVERY = 1;

/** The ending that is not, on its own, worth a row. */
const BORING_OUTCOME = "done";

/** Where a route's tail begins. */
const TAIL_QUANTILE = 0.99;

/**
 * How many requests a route's latency picture holds before it is halved.
 *
 * Halving rather than clearing, so the threshold is available from the first
 * request instead of after a warm-up a quiet route would take days to finish,
 * and so it slides with the traffic instead of stepping between windows. The
 * count is per route: 1,024 is a few hours of the busiest one and weeks of the
 * quietest, which is the right memory for "slow, for this endpoint, lately".
 */
const DISTRIBUTION_WINDOW = 1024;

/**
 * The histogram's edges, minus the `Infinity` its last bucket is closed with.
 * A threshold has to be a duration a request can exceed, and nothing exceeds
 * that one — reading it as a threshold would silently switch the tail rule off
 * on exactly the route slow enough to push its p99 into the last bucket.
 */
const TAIL_EDGES = DURATION_MS_BOUNDARIES.filter((edge) =>
  Number.isFinite(edge)
);

/** One bucket per edge, plus one for everything past the last of them. */
const BUCKET_COUNT = TAIL_EDGES.length + 1;

const EMPTY_BUCKETS: readonly number[] = Array.from(
  { length: BUCKET_COUNT },
  () => 0
);

/** What one route's traffic has looked like lately. */
interface RouteState {
  /**
   * Requests per duration bucket, decayed. Fractional after a halving, which is
   * intended: these are weights, not a count anybody reads.
   */
  readonly buckets: readonly number[];
  /** The sum of {@link buckets}, carried rather than re-added per request. */
  readonly total: number;
  /**
   * Requests on this route that reached the one-in-N turn. Only those, so the
   * stamped `sampleRate` is exactly the number of requests each kept row stands
   * for — counting the ones kept for cause here would advance the turn without
   * anything riding on it and make the weight an overstatement.
   */
  readonly turns: number;
}

const EMPTY_ROUTE: RouteState = {
  buckets: EMPTY_BUCKETS,
  total: 0,
  turns: 0,
};

/** The bucket a duration lands in: the first edge it does not exceed. */
const bucketOf = (durationMs: number) => {
  const found = TAIL_EDGES.findIndex((edge) => durationMs <= edge);
  return found === -1 ? TAIL_EDGES.length : found;
};

/**
 * The duration a request has to beat to count as this route's tail: the lowest
 * bucket boundary with 99% of the route's traffic at or below it. Reading the
 * boundary rather than interpolating inside the bucket is what makes the rule
 * conservative — at most one request in a hundred is above the value returned,
 * so the tail cannot quietly become a third of the ledger.
 *
 * It is called with the current request already folded in, so a route with
 * barely any history answers with a bucket the request itself is inside and
 * keeps nothing on this rule. That is the honest answer — a hundred
 * observations is the least a one-in-a-hundred threshold can be read from, and
 * a route reaches that in hours — and the outcome rule already covers the
 * endings that matter while the picture fills in.
 */
const tailThresholdOf = (state: RouteState) => {
  const wanted = state.total * TAIL_QUANTILE;
  let below = 0;
  for (const [index, edge] of TAIL_EDGES.entries()) {
    below += state.buckets[index] ?? 0;
    if (below >= wanted) {
      return edge;
    }
  }
  // More than one request in a hundred took longer than the widest bucket
  // describes. The tail starts at that edge and everything past it is kept —
  // a gateway in that state is one nobody should be sampling quietly.
  return TAIL_EDGES.at(-1) ?? 0;
};

/** Halves every weight, so a route's picture forgets at a steady rate. */
const decayed = (state: RouteState): RouteState => ({
  buckets: state.buckets.map((count) => count / 2),
  total: state.total / 2,
  turns: state.turns,
});

/**
 * Folds one request's duration into the route's picture. Every request is
 * observed, kept or dropped: the distribution has to describe the traffic, and
 * a threshold derived from the rows that survived it would climb until nothing
 * qualified.
 */
const observed = (state: RouteState, durationMs: number): RouteState => {
  const landed = bucketOf(durationMs);
  const grown: RouteState = {
    buckets: state.buckets.map((count, index) =>
      index === landed ? count + 1 : count
    ),
    total: state.total + 1,
    turns: state.turns,
  };
  return grown.total > DISTRIBUTION_WINDOW ? decayed(grown) : grown;
};

/** A request kept for what it is, rather than as one of a run of them. */
const KEPT_WHOLE = 1;

/**
 * The three reasons a finished request is worth a row on its own. `durationMs`
 * is null only on a row the emitter could not measure, which the `?? 0` files
 * as fast — the outcome rule has already caught anything that went wrong.
 */
const isInteresting = (
  row: FinishedRequest,
  threshold: number,
  durationMs: number
) => row.outcome !== BORING_OUTCOME || row.sse || durationMs > threshold;

/**
 * The weight to stamp on this row, or null to drop it, and the route's picture
 * with this request folded in. Pure, so the whole predicate is one function a
 * test can drive without a clock, a socket or a file.
 */
const rateFor = (
  state: RouteState,
  row: FinishedRequest,
  oneIn: number
): readonly [number | null, RouteState] => {
  const durationMs = row.durationMs ?? 0;
  // Against the picture including this request: with one observation its own
  // bucket holds all of the traffic, so the first request on a route is never
  // its own outlier.
  const next = observed(state, durationMs);
  if (isInteresting(row, tailThresholdOf(next), durationMs)) {
    return [KEPT_WHOLE, next];
  }
  const kept = next.turns % oneIn === 0;
  return [kept ? oneIn : null, { ...next, turns: next.turns + 1 }];
};

/** Decides what the ledger keeps of the traffic the counters have already seen. */
export interface RequestSampler {
  /**
   * What this row weighs, or null when it is not kept. Never fails: the caller
   * is a finalizer, and a predicate is not allowed to be why a request dies.
   */
  readonly rateFor: (row: FinishedRequest) => Effect.Effect<number | null>;
}

/**
 * One sampler, built with the layer rather than at module scope, so its picture
 * of the traffic belongs to the process it was built for and a test gets a fresh
 * one per handler.
 */
export const makeRequestSampler = Effect.gen(function* () {
  const configured = yield* Config.int("GATEWAY_SAMPLE_ONE_IN").pipe(
    Config.withDefault(DEFAULT_SAMPLE_ONE_IN)
  );
  // Zero would divide the turn by nothing and a negative one would run it
  // backwards; both mean "keep everything", which is what one already says.
  const oneIn = Math.max(configured, KEEP_EVERY);
  const routes = yield* Ref.make<Readonly<Record<string, RouteState>>>({});
  return {
    rateFor: (row: FinishedRequest) =>
      Ref.modify(routes, (byRoute) => {
        // The bounded route vocabulary, the same one the metrics are tagged by:
        // keying this map on the raw pattern would let a caller's probe grow it.
        const key = routeTag(row.route);
        const [rate, next] = rateFor(byRoute[key] ?? EMPTY_ROUTE, row, oneIn);
        return [rate, { ...byRoute, [key]: next }];
      }),
  } as const satisfies RequestSampler;
});
