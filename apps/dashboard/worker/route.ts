/**
 * What the service worker is allowed to do with a request, decided on facts
 * about the request alone.
 *
 * It is a separate module from the worker because this is the part that has to
 * be right and the part a test can reach: the worker itself only runs inside a
 * `ServiceWorkerGlobalScope`, and the rules below are the whole of what keeps
 * live data out of a cache.
 */

/**
 * The three things that can happen to a request.
 *
 * `pass-through` is not "fetch it and hand it back" — it is the worker
 * declining to call `respondWith` at all, which leaves the request exactly as
 * it would be with no worker installed. That distinction is the reason the
 * event stream still streams: a response the worker touches is a response the
 * worker has buffered.
 */
export type Handling = "asset" | "navigate" | "pass-through";

/** Everything the decision reads, lifted off `Request` so a test can state it. */
export interface RequestFacts {
  /** The `Accept` header, or nothing where the caller sent none. */
  readonly accept: string | null;
  readonly method: string;
  /** `Request.mode`; only `navigate` is treated specially. */
  readonly mode: string;
  readonly path: string;
  readonly sameOrigin: boolean;
}

/**
 * Every top-level path the gateway answers on, as the dev server's proxy lists
 * them. In production the gateway is a second origin and the cross-origin rule
 * below already covers it; this is what keeps the worker honest when the two
 * share an origin, which is how `vite preview` and any future single-origin
 * deployment behave.
 */
const GATEWAY_PREFIXES = [
  "/api/auth",
  "/tasks",
  "/projects",
  "/threads",
  "/health",
] as const;

/**
 * The run event stream, named rather than inferred.
 *
 * It is already covered twice over — it is cross-origin in production and it
 * sits under `/tasks` — and it is written out anyway because it is the one
 * route where a worker in the way does not fail, it hangs: `respondWith` on an
 * `EventSource` buffers the body, and a stream that never flushes looks exactly
 * like a run that has gone quiet.
 */
const RUN_EVENT_STREAM = /^\/tasks\/[^/]+\/runs\/[^/]+\/events\/stream$/;

/** Server-sent events, whoever asked for them. */
const EVENT_STREAM = "text/event-stream";

const underPrefix = (path: string, prefix: string) =>
  path === prefix || path.startsWith(`${prefix}/`);

export const isGatewayPath = (path: string) =>
  GATEWAY_PREFIXES.some((prefix) => underPrefix(path, prefix));

/**
 * How one request is handled.
 *
 * The order matters and is the argument. Anything that is not a plain GET, and
 * anything that is not this origin, is left alone before the worker has looked
 * at it — the board is live data on the gateway's origin and every call to it
 * carries the session cookie, so there is no version of caching it that is
 * better than not caching it. Then the two streaming cases, then navigations,
 * which are the app's own shell whatever path they name, and only then the
 * gateway's own paths on this origin — because `/tasks/<id>` is both a page the
 * router owns and the address the contract reads that task from, and what tells
 * them apart is that one of them is a navigation.
 */
export const handlingOf = (facts: RequestFacts): Handling => {
  if (facts.method !== "GET" || !facts.sameOrigin) {
    return "pass-through";
  }
  if (facts.accept?.includes(EVENT_STREAM) === true) {
    return "pass-through";
  }
  if (RUN_EVENT_STREAM.test(facts.path)) {
    return "pass-through";
  }
  if (facts.mode === "navigate") {
    return "navigate";
  }
  if (isGatewayPath(facts.path)) {
    return "pass-through";
  }
  return "asset";
};
