/**
 * Where a handler's repositories come from, and why it is not the request.
 *
 * A repository is a handle on the process's connection pool. It does not change
 * between requests, and asking for one inside a handler makes it a *request*
 * requirement — which the router tracks separately, and which the composition
 * root can only satisfy through a second, per-request layer build. Two builds
 * of the store are two connection pools, both claiming to be this gateway, and
 * whether that happens turns on the order two combinators are piped in. That is
 * too subtle a thing for a connection budget to rest on.
 *
 * So every group takes what it needs once, while its layer is being built, and
 * hands it to each request. What a request genuinely owns — who is calling, the
 * decoded body, the route's parameters — is still read per request, from the
 * services the middleware and the router provide.
 */

import { Effect } from "effect";

/**
 * Captures the services a group was built over and provides them to each of its
 * handlers.
 *
 * Yield it at the top of a group builder, naming the services that group
 * reaches for: `const on = yield* atBuild<TaskRepo | RunRepo>()`. The returned
 * function leaves every other requirement of the effect alone, so a handler
 * still reads `Principal` from the middleware that resolved it.
 */
export const atBuild = <Services>() =>
  Effect.map(
    Effect.context<Services>(),
    (services) =>
      <A, E, R>(handler: Effect.Effect<A, E, R>) =>
        Effect.provideContext(handler, services)
  );
