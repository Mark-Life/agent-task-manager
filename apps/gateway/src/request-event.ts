/**
 * The `atm.request` wide event: one row per HTTP request the gateway answers.
 * The counters derived from the same row live in `./request-metrics`, which is
 * where the cardinality rules are kept.
 *
 * A request is the unit of work this process owns, and what is asked of it
 * afterwards is always a `GROUP BY` over a column that has to already exist:
 * which operation is slow, which workspace drives the load, whether a person or
 * a worker run made the call, how many credentials are refused and at which
 * scope, how long the dashboard's streams stay open. Four properties are
 * load-bearing, and this file enforces each.
 *
 * **The route pattern, never the path**, which is unbounded and would be a new
 * metric series per task. It comes off the `http.route` attribute the router
 * writes onto the request span, so it is the pattern that actually matched. A
 * request that matched nothing carries `pathShape` beside it — how far the path
 * got into the contract before it stopped making sense — because otherwise
 * every 404 is the same row and the population cannot be split.
 *
 * **One row per request, written when the request is over — for a stream, when
 * the stream ends.** An SSE response returns from its handler in milliseconds
 * and then holds for an hour, so a row emitted at the handler's exit would say
 * every stream lasted no time at all. The platform models the real lifetime:
 * the request scope is transferred to the response stream and closed when that
 * stream exits, so the single emit hangs off a finalizer on that scope.
 *
 * **`traceId` is the caller's when the caller has one**, because the platform's
 * tracer parents the request span from an inbound `traceparent`.
 * {@link requestTraceparent} is how that id would leave again — see it for the
 * one seam it cannot cross yet.
 *
 * **A refused credential is a row, not a silence.** The access middleware files
 * its verdict through `./auth/record`; this file provides that recorder per
 * request and reads it as the row is built. One event, not two: a refusal is
 * `outcome: "rejected"` on the row everything else is counted from.
 *
 * Content is measured, never carried — byte counts and a status, no bodies, no
 * header but the trace context, and no query string, which is caller-controlled
 * and can hold a token. Path parameters are caller-controlled too, so the ids
 * lifted off them are clipped like any other free text.
 *
 * **A request is counted once and stored sometimes.** This is the one marker in
 * the system whose volume follows a screen being open rather than work being
 * done, so the row passes `./request-sampling` before it is written: everything
 * that failed, streamed or ran long is kept, the rest is thinned and stamped
 * with what it weighs. The counters in `./request-metrics` are updated above
 * that decision and still describe every request.
 *
 * Wiring is one line in the composition root — `Layer.provide(requestEventLayer)`
 * on the API layer in `./layers`. The layer registers itself with the router, so
 * every route is covered, including the ones added later.
 */

import {
  clipError,
  defineEvent,
  emitEvent,
  outcomeField,
  SanitizedText,
  Telemetry,
  type TelemetryInterface,
} from "@workspace/telemetry";
import {
  Cause,
  Clock,
  Context,
  Effect,
  type Exit,
  Option,
  Ref,
  Schema,
  Scope,
  Stream,
  type Tracer,
} from "effect";
import {
  HttpBody,
  type HttpMethod,
  HttpRouter,
  HttpServerError,
  HttpServerRequest,
  HttpServerResponse,
} from "effect/unstable/http";
import {
  AUTH_OUTCOMES,
  AUTH_SCHEMES,
  type AuthRecord,
  makeRequestAuth,
  RequestAuth,
  type RequestAuthShape,
} from "./auth/record";
import {
  HTTP_METHODS,
  moveSseConnections,
  pathShapeOf,
  recordRequestMetrics,
  UNMATCHED_ROUTE,
} from "./request-metrics";
import { makeRequestSampler, type RequestSampler } from "./request-sampling";

/** The filter key every query over gateway traffic starts from. */
export const REQUEST_EVENT_MARKER = "atm.request";

/** The span attribute the router writes the matched pattern onto. */
const HTTP_ROUTE_ATTRIBUTE = "http.route";

/**
 * The ending the base union cannot express: a refused credential is not a
 * server fault and not a success, and folding it into either is how a
 * misconfigured token stops being countable.
 */
export const REQUEST_EXTRA_OUTCOMES = ["rejected"] as const;

/** Status at or above which the gateway is blaming itself rather than the caller. */
const SERVER_ERROR_STATUS = 500;

/** The media type that makes a streamed body a held connection. */
const EVENT_STREAM_TYPE = "text/event-stream";

/**
 * What the response turned out to be, folded in as the handler exits. It exists
 * for the paths that answer nothing — a request killed before the handler leaves
 * no response object to read a status off — and because a streamed response
 * outlives that exit by an hour.
 */
export interface RequestProgress {
  /** Counted as a stream goes out, from the content length otherwise. */
  readonly bytesOut: number | null;
  readonly errorClass: string | null;
  readonly errorMessage: string | null;
  /** Killed rather than answered — a client that hung up, or a shutdown. */
  readonly interrupted: boolean;
  /** When the response left the handler, which a stream's hold is measured from. */
  readonly respondedAt: number | null;
  /** An event stream, which is what the gauge counts. */
  readonly sse: boolean;
  readonly status: number | null;
  /** Any streamed body — an event stream, or an artifact read off disk. */
  readonly streamed: boolean;
}

/** A request that has been received and has answered nothing yet. */
export const emptyRequestProgress: RequestProgress = {
  bytesOut: null,
  errorClass: null,
  errorMessage: null,
  interrupted: false,
  respondedAt: null,
  sse: false,
  status: null,
  streamed: false,
};

/** A fresh accumulator for one request. */
export const makeRequestProgress = Ref.make(emptyRequestProgress);

/**
 * The cell the current request folds its facts into, or null outside one. A
 * reference rather than an argument, because the code that learns a fact is
 * nowhere near the middleware that writes the row, and threading a `Ref`
 * through eight handler files is how one of them ends up not doing it.
 */
export const CurrentRequestProgress =
  Context.Reference<Ref.Ref<RequestProgress> | null>(
    "gateway/CurrentRequestProgress",
    { defaultValue: () => null }
  );

/**
 * Folds what the gateway just learned into this request's row — a handler
 * naming its own failure, `observeRequest({ errorClass: error._tag })`. A no-op
 * outside a request: telemetry may never be why a handler cannot run.
 */
export const observeRequest = (patch: Partial<RequestProgress>) =>
  Effect.flatMap(CurrentRequestProgress, (cell) =>
    cell === null
      ? Effect.void
      : Ref.update(cell, (current) => ({ ...current, ...patch }))
  );

/**
 * One request. The shared identity, economics, outcome and environment
 * vocabulary comes from the telemetry base; everything below is a question the
 * base cannot answer.
 *
 * The economics are null throughout and that is not an omission: what a request
 * costs is what the run it started costs, and `atm.run` is where that is
 * counted. `durationMs` is the exception, being the one measurement this unit
 * produces. The `auth*` fields are the access middleware's verdict lifted whole
 * off the record it filed, so "which route refuses task-write tokens" is one
 * query rather than a join.
 */
export const RequestEvent = defineEvent(REQUEST_EVENT_MARKER, {
  actorKind: Schema.NullOr(SanitizedText),
  /** The task a run's token is confined to — against `taskId`, the one it asked for. */
  authBoundTaskId: Schema.NullOr(SanitizedText),
  /** Null on the routes needing no credential: `/health`, and the auth library's own. */
  authOutcome: Schema.NullOr(Schema.Literals(AUTH_OUTCOMES)),
  /** Why a credential was refused, from the closed set the access middleware keeps. */
  authReason: Schema.NullOr(SanitizedText),
  /** What the endpoint asked for, worth reading when it was not met. */
  authRequired: Schema.NullOr(SanitizedText),
  authScheme: Schema.NullOr(Schema.Literals(AUTH_SCHEMES)),
  /** What the credential turned out to hold. */
  authScope: Schema.NullOr(SanitizedText),
  bytesOut: Schema.NullOr(Schema.Natural),
  method: Schema.Literals(HTTP_METHODS),
  outcome: outcomeField(REQUEST_EXTRA_OUTCOMES),
  /**
   * How far the path got into the contract, for a request that matched no
   * pattern; null when one matched, where `route` already says it. A 404's
   * message is suppressed below, so this is the only thing those rows can be
   * grouped by — and it is a bounded vocabulary, never the path.
   */
  pathShape: Schema.NullOr(SanitizedText),
  /** The pattern that matched — never the path, which is unbounded. */
  route: SanitizedText,
  /**
   * How many requests this row stands for — 1 for a row kept on its own merits,
   * the thinning factor for one kept as a representative of the traffic around
   * it. `./request-sampling` decides it; a count over these rows multiplies by
   * it. This is the only marker in the ledger that is a sample, so the field is
   * declared here rather than in the shared vocabulary: a row of any other kind
   * stands for exactly itself and an absent `sampleRate` reads as 1.
   */
  sampleRate: Schema.Natural.pipe(
    Schema.check(Schema.isGreaterThanOrEqualTo(1))
  ),
  sse: Schema.Boolean,
  status: Schema.Int,
  /** Response to stream end. Null when nothing streamed; the reason this row waits. */
  streamHeldMs: Schema.NullOr(Schema.Finite),
  /** The person behind the call. A run is on `runId` instead. */
  userId: Schema.NullOr(SanitizedText),
});

/** The row one request supplies, derived from the schema so it cannot drift. */
export type RequestEventInput = Parameters<typeof RequestEvent.encode>[0];

/**
 * The row as the sampling predicate receives it: everything a finished request
 * knows, before anything has decided what it weighs.
 */
export type FinishedRequest = Omit<RequestEventInput, "sampleRate">;

/** How a request ended, as the ledger and the counters spell it. */
type RequestOutcome = NonNullable<RequestEventInput["outcome"]>;

/** What the emit site knows before the request has done anything. */
interface RequestContext {
  /** Where the access middleware leaves its verdict; read once, as the row is built. */
  readonly auth: RequestAuthShape;
  readonly method: HttpMethod.HttpMethod;
  /** Path only: a query string is caller-controlled and can carry a credential. */
  readonly path: string;
  /**
   * One per process, not one per request: what it decides about this row is
   * read off a picture of the traffic every other request contributed to.
   */
  readonly sampler: RequestSampler;
  readonly span: Option.Option<Tracer.Span>;
  readonly startedAt: number;
}

/** The request's method, constrained to the values a row and a tag may hold. */
const methodOf = (method: string): HttpMethod.HttpMethod =>
  (HTTP_METHODS as readonly string[]).includes(method)
    ? (method as HttpMethod.HttpMethod)
    : "GET";

/**
 * The matched route pattern, off the span the router annotated. Absent means
 * nothing matched, which is worth counting as one thing rather than putting the
 * path somebody probed with onto a row.
 */
const routeOf = (span: Option.Option<Tracer.Span>) => {
  if (Option.isNone(span)) {
    return UNMATCHED_ROUTE;
  }
  const route = span.value.attributes.get(HTTP_ROUTE_ATTRIBUTE);
  return typeof route === "string" && route.length > 0
    ? route
    : UNMATCHED_ROUTE;
};

/** The path parameters that are identity, and the row fields they land on. */
const IDENTITY_PARAMS = ["runId", "sessionId", "taskId"] as const;

/**
 * The identity a task-scoped route carries in its path. Everything a task owns
 * is nested under `/tasks/:taskId`, so the ids joining this row to a run and a
 * session are already in the URL, and lifting them here saves eight handlers
 * from each remembering to record them.
 */
export const pathIdentity = (
  route: string,
  path: string
): Partial<Record<(typeof IDENTITY_PARAMS)[number], string>> => {
  const patterns = route.split("/");
  const segments = path.split("/");
  if (patterns.length !== segments.length) {
    return {};
  }
  const found: Record<string, string> = {};
  for (const [index, pattern] of patterns.entries()) {
    const segment = segments[index];
    const name = pattern.startsWith(":") ? pattern.slice(1) : null;
    if (
      name !== null &&
      segment !== undefined &&
      (IDENTITY_PARAMS as readonly string[]).includes(name)
    ) {
      found[name] = clipError(decodeURIComponent(segment));
    }
  }
  return found;
};

/** Whether a response body is an event stream, which is what makes it a held connection. */
const isEventStream = (response: HttpServerResponse.HttpServerResponse) =>
  response.body._tag === "Stream" &&
  (response.body.contentType ?? "").startsWith(EVENT_STREAM_TYPE);

/** What a fixed body already knows about its own size. */
const contentLengthOf = (body: HttpBody.HttpBody) =>
  "contentLength" in body ? (body.contentLength ?? null) : null;

/** What to call something thrown that named itself nothing. */
const nameOf = (thrown: unknown) =>
  thrown instanceof Error ? thrown.name : "UnknownError";

/**
 * Failures whose whole message is the request line, path and query string
 * included. The class already says everything the message would, and the text
 * is the one place a caller-controlled URL could reach a durable sink. What the
 * suppressed message was wanted for is on `pathShape`, bounded.
 */
const REQUEST_ECHOING_CLASSES: ReadonlySet<string> = new Set([
  "RouteNotFound",
  "RequestParseError",
]);

/**
 * What to call a failure that never became a handled response. A platform error
 * names itself twice — `HttpServerError` and the reason inside it — and the
 * reason is the half that says what went wrong.
 */
const describeCause = (cause: Cause.Cause<unknown>) => {
  const failure = Cause.findErrorOption(cause);
  const thrown = Option.isSome(failure) ? failure.value : Cause.squash(cause);
  const named = thrown as {
    readonly _tag?: unknown;
    readonly reason?: { readonly _tag?: unknown };
  } | null;
  const tag = named?.reason?._tag ?? named?._tag;
  const errorClass = typeof tag === "string" ? tag : nameOf(thrown);
  return {
    errorClass,
    errorMessage: REQUEST_ECHOING_CLASSES.has(errorClass)
      ? null
      : clipError(thrown instanceof Error ? thrown.message : String(thrown)),
  };
};

/**
 * The response the caller will actually be sent, on every exit path, from the
 * platform's own mapping rather than a table here: an unknown route is 404, a
 * client that hung up 499, a shutdown 503, an unhandled defect 500.
 */
const responseOf = (
  exit: Exit.Exit<HttpServerResponse.HttpServerResponse, unknown>
) =>
  exit._tag === "Success"
    ? Effect.succeed(exit.value)
    : Effect.map(
        HttpServerError.causeResponse(exit.cause),
        ([response]) => response
      );

/**
 * Everything the response says about itself, folded in as the handler exits.
 * The failure is described here rather than at emit time because the cause is
 * gone by then: the finalizer that writes the row sees the scope's exit, which
 * for a streamed response is the stream's and not the handler's.
 */
const observeResponse = (
  exit: Exit.Exit<HttpServerResponse.HttpServerResponse, unknown>
) =>
  Effect.gen(function* () {
    const response = yield* responseOf(exit);
    const streamed = response.body._tag === "Stream";
    const respondedAt = yield* Clock.currentTimeMillis;
    yield* observeRequest({
      // A stream's bytes are counted as they go out; a fixed body already knows.
      bytesOut: streamed ? 0 : contentLengthOf(response.body),
      interrupted:
        exit._tag === "Failure" && Cause.hasInterruptsOnly(exit.cause),
      respondedAt,
      sse: isEventStream(response),
      status: response.status,
      streamed,
      ...(exit._tag === "Failure" ? describeCause(exit.cause) : {}),
    });
  });

/**
 * Counts the bytes of a streamed body as they leave. Tapped rather than
 * measured, because a streaming response has no content length by construction.
 * Media type, chunks and their order are untouched.
 */
const countingBody = (
  progress: Ref.Ref<RequestProgress>,
  body: HttpBody.Stream
) =>
  HttpBody.stream(
    body.stream.pipe(
      Stream.tap((chunk) =>
        Ref.update(progress, (current) => ({
          ...current,
          bytesOut: (current.bytesOut ?? 0) + chunk.length,
        }))
      )
    ),
    body.contentType,
    body.contentLength
  );

/**
 * How the request ended, from the accumulator, the credential's verdict and the
 * scope's exit together — the exit being what sees the interrupt a stream is cut
 * by, long after the handler. A refusal outranks everything: the request did not
 * fail, it was turned away. An interrupt is next. A status the gateway chose is
 * not a failure — a 404 for a task that is not there and a 422 for a body that
 * will not decode are the API answering correctly, and folding them into
 * `errored` makes an agent's typo indistinguishable from a database that is down.
 */
const outcomeOf = (
  progress: RequestProgress,
  auth: AuthRecord | null,
  exit: Exit.Exit<unknown, unknown>
): RequestOutcome => {
  if (auth !== null && auth.authOutcome !== "granted") {
    return "rejected";
  }
  if (
    progress.interrupted ||
    (exit._tag === "Failure" && Cause.hasInterruptsOnly(exit.cause))
  ) {
    return "interrupted";
  }
  return (progress.status ?? SERVER_ERROR_STATUS) >= SERVER_ERROR_STATUS
    ? "errored"
    : "done";
};

/** What the verdict fields say on a route that checked no credential. */
const NO_CREDENTIAL = {
  actorKind: null,
  authBoundTaskId: null,
  authOutcome: null,
  authReason: null,
  authRequired: null,
  authScheme: null,
  authScope: null,
  userId: null,
  workspaceId: null,
} as const;

/** The credential's verdict as row fields, minus the ids the base already names. */
const authFields = (auth: AuthRecord | null) =>
  auth === null
    ? NO_CREDENTIAL
    : {
        actorKind: auth.actorKind,
        authBoundTaskId: auth.authBoundTaskId,
        authOutcome: auth.authOutcome,
        authReason: auth.authReason,
        authRequired: auth.authRequired,
        authScheme: auth.authScheme,
        authScope: auth.authScope,
        userId: auth.userId,
        workspaceId: auth.workspaceId,
      };

/**
 * Builds the row from the four things that know about the request: what was
 * known when it arrived, what the credential turned out to be, what the response
 * did, and how it ended. `durationMs` is received to answered, so a stream held
 * for an hour does not move the latency a caller experiences — that hour is
 * `streamHeldMs`, beside it.
 */
const requestRow = (
  context: RequestContext,
  progress: RequestProgress,
  auth: AuthRecord | null,
  exit: Exit.Exit<unknown, unknown>,
  endedAt: number
): FinishedRequest => {
  const route = routeOf(context.span);
  const identity = pathIdentity(route, context.path);
  const span = Option.getOrUndefined(context.span);
  return {
    ...authFields(auth),
    bytesOut: progress.bytesOut,
    // The run's economics belong to the run's own row; counting them here too
    // would count every dispatch twice.
    costUsd: null,
    durationMs: (progress.respondedAt ?? endedAt) - context.startedAt,
    errorClass: progress.errorClass,
    errorMessage: progress.errorMessage,
    method: context.method,
    outcome: outcomeOf(progress, auth, exit),
    pathShape: route === UNMATCHED_ROUTE ? pathShapeOf(context.path) : null,
    // A request is one row: a stream that outlives its answer is visible as a
    // live connection on the gauge, not as a start row nothing pairs with.
    phase: "end",
    // Nothing queues in front of a request; the wait for a worker slot is the
    // loop's measurement, on the run this request may have asked for.
    queueWaitMs: null,
    route,
    runId: identity.runId ?? auth?.runId ?? null,
    sessionId: identity.sessionId ?? auth?.sessionId ?? null,
    spanId: span?.spanId ?? null,
    sse: progress.sse,
    // Every path has a status, including the ones with no response object.
    status: progress.status ?? SERVER_ERROR_STATUS,
    streamHeldMs:
      progress.streamed && progress.respondedAt !== null
        ? endedAt - progress.respondedAt
        : null,
    // The task the route addressed, which is not always the one a run's token
    // is bound to — that is `authBoundTaskId`, and the pair is the refusal.
    taskId: identity.taskId ?? auth?.authBoundTaskId ?? null,
    totalTokens: null,
    // The caller's trace where the caller had one, this process's otherwise.
    traceId: span?.traceId ?? null,
    turns: null,
  };
};

/**
 * The one emit site: the row, the counters derived from it, then the predicate
 * that decides whether the row is stored. The counters go first and
 * unconditionally — they describe every request the gateway answered, and the
 * ledger a sample of them, which is the only ordering under which an exact
 * count and a thinned ledger can both be true. Everything is inside
 * `ignoreCause`, construction included, so a field that will not encode is a
 * dropped row rather than a request that dies finalizing.
 */
const closeRequest = (
  context: RequestContext,
  progress: Ref.Ref<RequestProgress>,
  exit: Exit.Exit<unknown, unknown>
) =>
  Effect.gen(function* () {
    const state = yield* Ref.get(progress);
    const auth = yield* context.auth.get;
    const endedAt = yield* Clock.currentTimeMillis;
    const row = requestRow(context, state, auth, exit, endedAt);
    if (state.sse) {
      yield* moveSseConnections(row.route, -1);
    }
    yield* recordRequestMetrics({
      durationMs: row.durationMs ?? 0,
      method: row.method,
      route: row.route,
      status: row.status,
    });
    const sampleRate = yield* context.sampler.rateFor(row);
    if (sampleRate !== null) {
      yield* emitEvent(RequestEvent, { ...row, sampleRate });
    }
  }).pipe(Effect.ignoreCause);

/** Where a URL stops being a path. */
const PATH_END = /[?#]/;

/** The path without its query string, which is caller-controlled and can carry a token. */
const pathOf = (url: string) => url.split(PATH_END)[0] ?? url;

/**
 * Wraps one request so it leaves exactly one `atm.request` row, on every exit
 * path — a clean answer, a typed failure, a defect, a client that hung up, and
 * the interrupt a shutdown produces. The emit hangs off a finalizer on the
 * request's scope rather than the handler's exit: the platform transfers that
 * scope to a streamed response and closes it when the stream ends, so one
 * finalizer covers both lifetimes. The accumulator is read as the scope closes,
 * which is safe precisely there — the access middleware, the handlers and the
 * stream's byte count have all finished by then.
 */
const instrument =
  (telemetry: TelemetryInterface, sampler: RequestSampler) =>
  <A extends HttpServerResponse.HttpServerResponse, E, R>(
    app: Effect.Effect<A, E, R>
  ) =>
    Effect.gen(function* () {
      const request = yield* HttpServerRequest.HttpServerRequest;
      const scope = yield* Effect.scope;
      const progress = yield* makeRequestProgress;
      const context: RequestContext = {
        auth: yield* makeRequestAuth,
        method: methodOf(request.method),
        path: pathOf(request.url),
        sampler,
        // The span the platform's tracer opened for this request, parented from
        // the caller's `traceparent` where there was one. Captured now and read
        // as the row is built: by then `Effect.currentSpan` answers nothing.
        span: yield* Effect.option(Effect.currentSpan),
        startedAt: yield* Clock.currentTimeMillis,
      };
      yield* Scope.addFinalizerExit(scope, (exit) =>
        closeRequest(context, progress, exit).pipe(
          Effect.provideService(Telemetry, telemetry)
        )
      );
      return yield* app.pipe(
        Effect.onExit((exit) => observeResponse(exit)),
        Effect.map((response) =>
          response.body._tag === "Stream"
            ? (HttpServerResponse.setBody(
                response,
                countingBody(progress, response.body)
              ) as A)
            : response
        ),
        Effect.tap((response) =>
          isEventStream(response)
            ? moveSseConnections(routeOf(context.span), 1)
            : Effect.void
        ),
        Effect.provideService(RequestAuth, context.auth),
        Effect.provideService(CurrentRequestProgress, progress)
      );
    });

/**
 * The instrumentation, as a global router middleware. Global rather than
 * per-route: a route added without it would be a route with no row, and
 * "somebody remembered" is not a property worth resting on. The telemetry
 * handle and the sampler are resolved once, at layer build, so the per-request
 * path costs no service lookup — and the sampler's picture of the traffic
 * belongs to the built layer rather than to the module, so a second gateway in
 * the same process does not sample against the first one's latencies.
 */
export const requestEventLayer = HttpRouter.middleware(
  Effect.gen(function* () {
    const telemetry = yield* Telemetry;
    const sampler = yield* makeRequestSampler;
    // Applied through an arrow rather than passed by name: a generic function
    // handed over as a value is instantiated at its constraints, which would
    // leave the middleware's error and requirement channels as `unknown` and
    // demand a context from every caller of the router.
    return (app) => instrument(telemetry, sampler)(app);
  }),
  { global: true }
);

/** W3C trace context version and sampling flag, as the header spells them. */
const TRACEPARENT_VERSION = "00";
const TRACEPARENT_SAMPLED = "01";

/**
 * The current request's trace as a `traceparent` header value — the form a trace
 * crosses a process boundary in, and how a task the manager creates over HTTP
 * would join the run that follows: written onto the row the orchestrator reads
 * at dispatch, the run's `traceId` continues the caller's trace.
 *
 * **That seam does not exist yet, and this deliberately does not route around
 * it.** `RunRepo.create` takes a `traceId`, but its only caller is the
 * orchestrator, passing its own claim span's. Nothing the gateway writes can
 * carry one: `run_command` has no trace column and `RunCommandRepo.enqueue` no
 * trace argument, `TaskRepo.transition` none either, and `RunCommandPayload` is
 * closed. Audit rows are the exception and get it free, every audited mutation
 * stamping the current span's trace.
 */
export const requestTraceparent = Effect.map(
  Effect.option(Effect.currentSpan),
  (span) =>
    Option.isNone(span)
      ? null
      : `${TRACEPARENT_VERSION}-${span.value.traceId}-${span.value.spanId}-${TRACEPARENT_SAMPLED}`
);
