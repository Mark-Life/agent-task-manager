/**
 * The contract, published: the OpenAPI document over HTTP and the page a person
 * reads it on.
 *
 * The document is derived from `@workspace/api`, never written by hand, so what
 * this serves and what the handlers implement cannot disagree. Two consumers,
 * two routes. `/openapi.json` is the machine's: Executor reads it and every
 * operation becomes a tool, which is the whole reason this system speaks HttpApi
 * rather than RPC. `/docs` is the person's, and it is the fastest way to answer
 * "what can this thing do" without a checkout.
 *
 * Neither route carries a credential. The spec describes the door, it does not
 * open it — `components.securitySchemes` names the three bearer scopes and the
 * session cookie, which is exactly how an external consumer learns which token
 * an operation wants. Serving it publicly is how a connector configures itself;
 * the operations behind it still refuse anything unauthenticated. If the whole
 * surface is meant to be private, that is Caddy's job, not a check here.
 *
 * The one thing added to the derived document is `servers`. Where this gateway
 * answers is a fact about a deployment, not about the contract, so it is read
 * from the environment here rather than annotated in `@workspace/api` — which
 * also keeps the checked-in `openapi.json` free of anybody's hostname. A
 * document with no origin on it has to have its base URL supplied by hand, and
 * the base URL is the thing people supply wrongly.
 */

import { Api, makeOpenApiSpec } from "@workspace/api";
import { Config, Effect, Layer } from "effect";
import { HttpRouter, HttpServerResponse } from "effect/unstable/http";
import { HttpApiScalar } from "effect/unstable/httpapi";

/** Where the derived document is served. Give this URL to a connector. */
export const OPENAPI_PATH = "/openapi.json";

/** Where the reference UI is served. */
export const DOCS_PATH = "/docs";

/**
 * The externally reachable base URL, which behind Caddy is not what the process
 * bound. Defaults to the bound port so a local run needs no environment at all
 * and the spec it serves is still directly usable.
 */
const publicUrlConfig = (port: number) =>
  Config.string("GATEWAY_PUBLIC_URL").pipe(
    Config.withDefault(`http://localhost:${port}`)
  );

/** OpenAPI server URLs are prefixes; a trailing slash makes every path double up. */
const TRAILING_SLASHES = /\/+$/;

/** Normalises the configured origin into something a path can be appended to. */
const trimTrailingSlash = (url: string) => url.replace(TRAILING_SLASHES, "");

/**
 * The derived document with this deployment's origin on it.
 *
 * A copy rather than a mutation: `OpenApi.fromApi` memoises per API value, and
 * writing into that object would put one deployment's hostname into every other
 * caller's spec — including the one `bun run openapi` checks in.
 */
const deployedSpec = (port: number) =>
  Effect.map(publicUrlConfig(port), (publicUrl) => ({
    ...makeOpenApiSpec(),
    servers: [
      {
        description: "This gateway",
        url: trimTrailingSlash(publicUrl),
      },
    ],
  }));

/**
 * Serves the document.
 *
 * Rendered once, at layer build, because the spec is a constant of the process:
 * a route that re-derived it would spend a hundred milliseconds of schema
 * traversal on every poll of a connector that only ever gets the same bytes.
 * The config read happens here too, so a malformed `GATEWAY_PUBLIC_URL` fails
 * the boot rather than the first request.
 */
const specLayer = (port: number) =>
  HttpRouter.use(
    Effect.fnUntraced(function* (router) {
      const spec = yield* deployedSpec(port);
      yield* router.add(
        "GET",
        OPENAPI_PATH,
        HttpServerResponse.jsonUnsafe(spec)
      );
    })
  );

/**
 * Serves the reference UI.
 *
 * `HttpApiScalar.layer` inlines the Scalar bundle into the page instead of
 * pulling it from jsDelivr. It costs a few megabytes per docs load and buys a
 * gateway whose documentation works on a host that cannot reach a CDN, or under
 * a content policy that forbids one — and the bundle is loaded into this process
 * either way, since the module imports it whichever variant is used.
 */
const scalarLayer = HttpApiScalar.layer(Api, { path: DOCS_PATH });

/**
 * Both routes, for the composition root to add beside the API's own.
 *
 * Takes the bound port rather than reading it, because the port belongs to the
 * server layer and two independent reads of one environment variable is one too
 * many ways for the spec to advertise a URL nothing is listening on.
 */
export const docsLayer = (port: number) =>
  Layer.merge(specLayer(port), scalarLayer);
