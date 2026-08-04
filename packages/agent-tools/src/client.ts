/**
 * The typed client for the board, derived from the contract itself.
 *
 * `HttpApiClient.make` builds every operation from the same `Api` value the
 * gateway implements, so a renamed field or a moved endpoint is a compile error
 * in the tool table below rather than a 404 the model reads as "the task does
 * not exist". That is the whole reason the manager's tools are not hand-written
 * `fetch` calls.
 *
 * The credential is attached by transforming the underlying `HttpClient` rather
 * than per call, so no tool can be added that forgets it. None of the API's
 * access middlewares declare a client-side requirement, so the only service the
 * construction needs is an `HttpClient`.
 */

import { Api } from "@workspace/api";
import { type Effect, Redacted } from "effect";
import { HttpClient, HttpClientRequest } from "effect/unstable/http";
import { HttpApiClient } from "effect/unstable/httpapi";
import type { GatewayConfig } from "./config";

/**
 * A client for the whole gateway contract, authenticated as the manager.
 *
 * The base url is what the *container* can reach, not what the host calls the
 * gateway: they differ under Docker, and using the host's spelling inside a
 * container is a connection refused on the first tool call.
 */
export const makeGatewayClient = (config: GatewayConfig) =>
  HttpApiClient.make(Api, {
    baseUrl: config.baseUrl,
    transformClient: HttpClient.mapRequest(
      HttpClientRequest.bearerToken(Redacted.value(config.token))
    ),
  });

/** The client every tool is written against. Derived, so it cannot be restated wrongly. */
export type GatewayClient = Effect.Success<
  ReturnType<typeof makeGatewayClient>
>;
