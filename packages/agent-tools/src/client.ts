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
 *
 * It is attached *effectfully*, because reading it can fail and can give a
 * different answer than it did a minute ago: a rolling credential is a file the
 * host rewrites while the turn runs (see `./config`). A read that fails is a
 * transport failure of that request and nothing more — the next call reads
 * again, so a turn does not lose its tools over one bad moment on the mount.
 */

import { Api } from "@workspace/api";
import { Effect, Redacted } from "effect";
import {
  HttpClient,
  HttpClientError,
  HttpClientRequest,
} from "effect/unstable/http";
import { HttpApiClient } from "effect/unstable/httpapi";
import { currentGatewayToken, type GatewayConfig } from "./config";

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
    transformClient: HttpClient.mapRequestEffect((request) =>
      currentGatewayToken(config.credential).pipe(
        Effect.map((token) =>
          HttpClientRequest.bearerToken(request, Redacted.value(token))
        ),
        // The client's own error channel, so this stays a client the API's
        // generated methods can be built from: every operation already answers
        // an `HttpClientError`, and a second error type here would be one every
        // tool has to name.
        Effect.mapError(
          (cause) =>
            new HttpClientError.HttpClientError({
              reason: new HttpClientError.TransportError({
                cause,
                description: cause.message,
                request,
              }),
            })
        )
      )
    ),
  });

/** The client every tool is written against. Derived, so it cannot be restated wrongly. */
export type GatewayClient = Effect.Success<
  ReturnType<typeof makeGatewayClient>
>;
