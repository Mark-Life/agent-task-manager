/**
 * The composition root. Every service the gateway answers on is built here,
 * once, and finalized once.
 *
 * The build order is the dependency order, bottom up:
 *
 *   platform (Bun's filesystem, path, crypto) + the Bun HTTP server
 *     └─ telemetry — logger, the JSONL ledger, the config-gated OTLP forwarder
 *          └─ store, notice multicast, access middleware
 *               └─ the handler groups
 *                    └─ the routed API, the spec, the reference UI,
 *                       and the middleware that leaves a row per request
 *
 * `HttpRouter.serve` is what replaced the removed `HttpApiBuilder.serve`: the
 * API becomes routes on a router, and the router is served over whichever
 * platform server layer is provided. That is also why nothing here is a
 * `WebHandler` — one process, one server, one scope to finalize.
 *
 * Three things are merged into what the router serves, and the third is the one
 * that is easy to leave out. The API is the contract's own routes. The docs
 * layer is the spec and the page that renders it. `requestEventLayer` is a
 * global router middleware, so it wraps every route on that router — the
 * contract's, the spec's, the auth library's, and the 404 for a path nobody
 * declared. Registering it here rather than per group is what makes "every
 * request leaves exactly one `atm.request` row" a property of the process
 * instead of something eight files remembered.
 *
 * The store goes in and stays in. Nothing outside a handler should hold a
 * repository, and exposing them would put the connection pool in the
 * environment of an entrypoint that has no business holding it. It is named
 * once, as a value, because a layer is memoised by identity: two calls to
 * `storeLayer` in this file would be two connection pools both claiming to be
 * this gateway.
 */

import { BunHttpServer, BunServices } from "@effect/platform-bun";
import { Api } from "@workspace/api";
import { CurrentActor, storeLayer } from "@workspace/db";
import { EventLog, telemetryLayer } from "@workspace/telemetry";
import { Config, Layer } from "effect";
import { HttpRouter } from "effect/unstable/http";
import { HttpApiBuilder } from "effect/unstable/httpapi";
import { accessLayer } from "./auth/access";
import { docsLayer } from "./docs";
import { handlersLayer } from "./handlers";
import { gatewayActor, SERVICE_NAME } from "./identity";
import { requestEventLayer } from "./request-event";
import { RunEventNotices } from "./sse";

/** The port the server binds when `GATEWAY_PORT` says nothing. */
const DEFAULT_PORT = 3100;

/** What to bind. Read here rather than in the entrypoint: it is a property of the server layer. */
export const gatewayPortConfig = Config.port("GATEWAY_PORT").pipe(
  Config.withDefault(DEFAULT_PORT)
);

/**
 * The logger, the durable ledger and the OTLP forwarder.
 *
 * The second `EventLog` is a read handle, not a second writer: the emitter
 * inside `telemetryLayer` owns the appends, and this one exists so the banner
 * can print the path an operator points `bun run logs` at.
 */
const observabilityLayer = Layer.mergeAll(
  telemetryLayer({ serviceName: SERVICE_NAME }),
  EventLog.layer({ serviceName: SERVICE_NAME })
).pipe(Layer.provideMerge(BunServices.layer));

/** Every repository over one connection pool, and the `PgClient` beneath them. */
const store = storeLayer({ applicationName: SERVICE_NAME });

/**
 * What a handler runs on: the repositories, the one `LISTEN` every open event
 * stream shares, the credential resolution every operation is gated by, and the
 * actor a write made by this process itself is attributed to.
 *
 * The actor here is the fallback, not the usual case — nearly every write is
 * made as the request's principal and overrides it. What it covers is the
 * writes the gateway makes on nobody's behalf.
 *
 * The access layer and the notice multicast sit *over* the store rather than
 * beside it: resolving a session cookie means asking the auth library, which is
 * built on the same connection pool the repositories use, and the multicast
 * listens on the `PgClient` that pool is behind. Merging the store back out
 * keeps the repositories available to the groups above.
 */
const requestServicesLayer = Layer.mergeAll(
  accessLayer,
  RunEventNotices.layer
).pipe(
  Layer.provideMerge(Layer.merge(CurrentActor.layer(gatewayActor), store))
);

/** The contract and its handlers, as routes on the router. */
const apiLayer = HttpApiBuilder.layer(Api).pipe(Layer.provide(handlersLayer));

/**
 * Everything that answers on the router: the contract, the published document,
 * and the wide event wrapped around both.
 *
 * One `Layer.provide` covers the lot, and it has to be here rather than outside
 * `HttpRouter.serve` — `accessLayer` mounts the auth library's own routes, so it
 * needs the very router being served, which `serve` provides to the layer it is
 * handed and to nothing else.
 */
const routesLayer = (port: number) =>
  Layer.mergeAll(apiLayer, docsLayer(port), requestEventLayer).pipe(
    Layer.provide(requestServicesLayer)
  );

/**
 * The whole process, as one layer.
 *
 * Provide it to the entrypoint and nothing else: a second build would mean a
 * second connection pool and a second ledger handle both claiming to be this
 * gateway. Telemetry is exposed rather than hidden, because the entrypoint
 * legitimately writes its banner through the logger it configures.
 */
export const appLayer = (port: number) =>
  HttpRouter.serve(routesLayer(port)).pipe(
    Layer.provide(BunHttpServer.layer({ port })),
    Layer.provideMerge(observabilityLayer)
  );
