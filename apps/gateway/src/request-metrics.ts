/**
 * The bounded projection of `atm.request`: three series-safe instruments,
 * derived at the emit site from the same row the ledger stores.
 *
 * The split from `./request-event` is the cardinality boundary. Everything that
 * makes a row worth querying — workspace, task, run, user, the exact path — is
 * unbounded and belongs on the event only; everything here is drawn from a
 * vocabulary that can be written down, so the number of time series is a
 * property of the contract rather than of the traffic. Keeping the two in
 * separate files is what makes a new tag a deliberate edit here.
 *
 * The route vocabulary is the one that cannot be a `const` tuple: the value
 * arrives from the router at runtime, so {@link routeTag} bounds it instead —
 * the contract's own patterns pass through, everything else the process mounts
 * (the spec, the docs, the auth library's routes) shares one bucket, and the
 * ledger keeps the exact pattern either way.
 */

import { Api } from "@workspace/api";
import { boundedCounter, boundedHistogram, orNone } from "@workspace/telemetry";
import { Effect, Metric } from "effect";
import type { HttpMethod } from "effect/unstable/http";

/** What a request that matched no route is counted as. One value, not one per probe. */
export const UNMATCHED_ROUTE = "unmatched";

/** Everything the process serves that the contract does not name, in one bucket. */
export const OTHER_ROUTE = "other";

/**
 * The methods a row and a tag may hold, constrained to the platform's own
 * union: a method it learns about later is a compile error here rather than an
 * unlisted tag value in production.
 */
// biome-ignore format: one line reads as the closed set it is
export const HTTP_METHODS = ["DELETE", "GET", "HEAD", "OPTIONS", "PATCH", "POST", "PUT", "TRACE"] as const satisfies readonly HttpMethod.HttpMethod[];

/** Status classes, as a metric tag: five values, forever. */
export const STATUS_CLASSES = ["1xx", "2xx", "3xx", "4xx", "5xx"] as const;

/** The class boundary of a status code. */
const STATUS_CLASS_WIDTH = 100;

/** The status class of a response, as a tag. */
export const statusClassOf = (
  status: number
): (typeof STATUS_CLASSES)[number] =>
  STATUS_CLASSES[Math.trunc(status / STATUS_CLASS_WIDTH) - 1] ?? "5xx";

/**
 * Every route pattern the contract declares, read off the contract rather than
 * restated here — a copy of two dozen paths is a copy that rots.
 */
const CONTRACT_ROUTES = Object.values(Api.groups).flatMap((group) =>
  Object.values(group.endpoints).map((endpoint) => endpoint.path as string)
);

const ROUTE_TAGS = [UNMATCHED_ROUTE, OTHER_ROUTE, ...CONTRACT_ROUTES] as const;

const KNOWN_ROUTES: ReadonlySet<string> = new Set(ROUTE_TAGS);

/** The route as a tag: the pattern where the contract knows it, one bucket otherwise. */
export const routeTag = (route: string) =>
  KNOWN_ROUTES.has(route) ? route : OTHER_ROUTE;

/**
 * Requests answered. The ceiling is the contract's route count times eight
 * methods times five classes, and it cannot grow without the contract growing.
 */
const requestsTotal = boundedCounter("atm_requests_total", {
  description: "Requests answered, by route pattern, method and status class",
  tags: {
    method: HTTP_METHODS,
    route: ROUTE_TAGS,
    statusClass: STATUS_CLASSES,
  },
});

/** Requests are milliseconds to tens of seconds; the buckets follow. */
const DURATION_MS_BOUNDARIES = Metric.exponentialBoundaries({
  count: 15,
  factor: 2,
  start: 1,
});

/**
 * Received to answered, per operation. The status class is deliberately not a
 * tag: a histogram is buckets times series, and the question latency answers is
 * "which operation is slow", not "how fast are the failures".
 */
const requestDurationMs = boundedHistogram("atm_request_duration_ms", {
  boundaries: DURATION_MS_BOUNDARIES,
  description: "Request received to response sent, per route pattern",
  tags: { method: HTTP_METHODS, route: ROUTE_TAGS },
});

/**
 * Event streams currently held open. A gauge rather than a counter because the
 * question is "how many are open right now" — a leaked stream is a number that
 * stops coming back down, which no count of opened connections shows. Built on
 * `Metric.gauge` directly, the telemetry package's bounded helpers covering
 * counters and histograms only, so the discipline is kept by hand: one tag,
 * from the same route vocabulary, through the same `orNone` sentinel.
 */
const sseConnections = Metric.gauge("atm_sse_connections", {
  description: "Event streams currently held open, by route pattern",
});

/** Moves the gauge for one connection, on the series its route names. */
export const moveSseConnections = (route: string, delta: number) =>
  Metric.modify(
    Metric.withAttributes(sseConnections, { route: orNone(routeTag(route)) }),
    delta
  );

/** The bounded half of one finished request. */
export interface RequestMeasurement {
  readonly durationMs: number;
  readonly method: (typeof HTTP_METHODS)[number];
  readonly route: string;
  readonly status: number;
}

/**
 * Counts the request from the same row the ledger stores, so the two cannot
 * disagree. Swallows its own failures, including a throw while deriving the
 * tags: a metric may never mask the work it describes.
 */
export const recordRequestMetrics = (measurement: RequestMeasurement) =>
  Effect.gen(function* () {
    const tags = {
      method: measurement.method,
      route: routeTag(measurement.route),
    };
    yield* requestsTotal.increment({
      ...tags,
      statusClass: statusClassOf(measurement.status),
    });
    yield* requestDurationMs.record(tags, measurement.durationMs);
  }).pipe(Effect.ignoreCause);
