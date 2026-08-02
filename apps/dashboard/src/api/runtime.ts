import { Api } from "@workspace/api";
import { Context, type Effect, Layer, ManagedRuntime } from "effect";
import { FetchHttpClient } from "effect/unstable/http";
import { HttpApiClient } from "effect/unstable/httpapi";
import { gatewayUrl } from "@/env";

/**
 * The whole contract, as the browser sees it.
 *
 * Derived from the same `Api` value the gateway implements, so an endpoint that
 * changes shape breaks this app at compile time rather than at a user's click.
 * Naming the type here keeps every consumer free of the `HttpApiClient`
 * generics.
 */
export type ApiClientShape = HttpApiClient.ForApi<typeof Api>;

/**
 * Transport that carries the session cookie.
 *
 * `credentials` is not a field on a request — it is configuration of `fetch`
 * itself — so it is supplied as a service to the transport layer instead of
 * being set per call. Without it the browser withholds the cookie and every
 * request comes back unauthorized.
 *
 * Every call also carries `traceparent` and `b3`, which is how the gateway
 * parents its request span on the click that caused it. Neither is
 * CORS-safelisted, so whatever fronts the API cross-origin has to allow both on
 * the preflight or nothing leaves the browser — see `deploy/Caddyfile`.
 */
const FetchLive = FetchHttpClient.layer.pipe(
  Layer.provide(
    Layer.succeed(FetchHttpClient.RequestInit, { credentials: "include" })
  )
);

/**
 * The typed client as a service, so effects can ask for it by name rather than
 * closing over a module-level value. Nothing else is in the runtime: the
 * contract's middlewares are server-side, so the client needs no credential
 * service and no security layer.
 */
export class ApiClient extends Context.Service<ApiClient, ApiClientShape>()(
  "dashboard/ApiClient"
) {}

const ApiClientLive = Layer.effect(
  ApiClient,
  HttpApiClient.make(Api, { baseUrl: gatewayUrl })
).pipe(Layer.provide(FetchLive));

/**
 * One runtime for the life of the page.
 *
 * The credential is a cookie the browser holds, so there is nothing
 * request-scoped to rebuild; constructing a client per call would only re-derive
 * the same handlers on every keystroke. Built at module load and never
 * disposed — the page unload disposes it.
 */
const runtime = ManagedRuntime.make(ApiClientLive);

/**
 * Run an effect against the API and get a promise back.
 *
 * The promise rejects with the failure value itself, not a wrapper, so a caller
 * keeps the endpoint's declared union and narrows on `_tag`. The optional
 * signal is how a cancelled query interrupts the fiber and aborts the
 * underlying request.
 */
export const run = <A, E>(
  effect: Effect.Effect<A, E, ApiClient>,
  signal?: AbortSignal
) => runtime.runPromise(effect, { signal });

/**
 * Run one call against the client without writing a generator for it.
 *
 * Most reads and writes are a single endpoint call, and `call((c) =>
 * c.tasks.board({ query: {} }))` says that with no ceremony. The signal is
 * forwarded exactly as {@link run} forwards it.
 */
export const call = <A, E>(
  f: (client: ApiClientShape) => Effect.Effect<A, E>,
  signal?: AbortSignal
) => run(ApiClient.use(f), signal);
