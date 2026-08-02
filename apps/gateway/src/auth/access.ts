/**
 * Authentication, as one layer: the routes that mint a session, and the three
 * middlewares that consume a credential.
 *
 * The contract declares an access middleware on every operation, so the scope
 * check cannot be forgotten by a handler; what this file supplies is the part
 * that turns a credential into a {@link Principal}. Both halves live together
 * because they are two ends of the same thing — a browser gets its cookie from
 * `/api/auth/*` and spends it on every other route, and splitting them would
 * mean a composition root that can mount one without the other.
 *
 * Nothing here decides anything. The decision is `./principal`, built once over
 * the auth instance and the token signer; these are the three names the
 * contract gave the same decision, each pinned to the scope its endpoints ask
 * for. `read` is every GET, `task-write` is ordinary work, `admin` is the
 * destructive end — and because a scope is a floor, an admin credential opens
 * all three doors while a read credential opens one.
 *
 * The two schemes on each middleware — bearer and cookie — are the same
 * function. They exist separately in the contract so the OpenAPI document can
 * name both credentials; which one a request actually presented is decided by
 * looking at the request, in one place, for the reason `./principal` explains.
 */

import {
  AdminAccess,
  type ApiScope,
  Principal,
  ReadAccess,
  TaskWriteAccess,
} from "@workspace/api";
import { Auth } from "@workspace/db";
import { Context, Effect, Layer } from "effect";
import {
  HttpRouter,
  HttpServerRequest,
  HttpServerResponse,
} from "effect/unstable/http";
import { makePrincipalResolver, type PrincipalResolver } from "./principal";
import { makeTokenSigner } from "./tokens";

/**
 * Where the auth library answers. Better Auth's own default, spelled out
 * because the dashboard's client and the cookie's `path` are both configured
 * against it, and a mismatch there is a login that appears to work and then
 * forgets itself.
 */
const AUTH_BASE_PATH = "/api/auth";

/**
 * The resolver, as a service, so the config read and the key derivation happen
 * once at layer build rather than once per middleware — there are three, and
 * they must agree about the secret.
 */
class Access extends Context.Service<Access, PrincipalResolver>()(
  "gateway/Access"
) {
  static readonly layer = Layer.effect(
    Access,
    Effect.gen(function* () {
      const auth = yield* Auth;
      const tokens = yield* makeTokenSigner;
      return makePrincipalResolver({ auth, tokens });
    })
  );
}

/**
 * One scope's check: resolve the credential, then run the endpoint as whoever
 * it turned out to be. A handler that never sees the request's headers cannot
 * disagree with this about who is calling.
 */
const guard =
  (resolver: PrincipalResolver, required: ApiScope) =>
  <A, E, R>(httpEffect: Effect.Effect<A, E, R>) =>
    Effect.flatMap(resolver.resolve(required), (principal) =>
      Effect.provideService(httpEffect, Principal, principal)
    );

/** Reads: every GET, including a run's task-bound token pointed at the rest of the board. */
const readAccessLayer = Layer.effect(
  ReadAccess,
  Effect.map(Access, (resolver) => {
    const check = guard(resolver, "read");
    return ReadAccess.of({ readToken: check, sessionCookie: check });
  })
);

/** Ordinary work. A run's token reaches these only on its own task. */
const taskWriteAccessLayer = Layer.effect(
  TaskWriteAccess,
  Effect.map(Access, (resolver) => {
    const check = guard(resolver, "task-write");
    return TaskWriteAccess.of({
      sessionCookie: check,
      taskWriteToken: check,
    });
  })
);

/** The destructive end. No agent's token is minted at this scope. */
const adminAccessLayer = Layer.effect(
  AdminAccess,
  Effect.map(Access, (resolver) => {
    const check = guard(resolver, "admin");
    return AdminAccess.of({ adminToken: check, sessionCookie: check });
  })
);

/**
 * Better Auth's own routes, mounted whole under {@link AUTH_BASE_PATH}.
 *
 * The library owns sign-in, sign-out, session refresh and the organization
 * plugin's membership endpoints, and it wants a web `Request` and answers with
 * a web `Response`. On Bun the incoming request already *is* one, so the
 * conversion is a passthrough and the body is never buffered here.
 *
 * These routes carry no access middleware of ours, which is the point: they are
 * how a person gets a credential, and they police themselves.
 */
const authRoutesLayer = Layer.effectDiscard(
  Effect.gen(function* () {
    const auth = yield* Auth;
    const router = yield* HttpRouter.HttpRouter;

    yield* router.add(
      "*",
      `${AUTH_BASE_PATH}/*`,
      (request: HttpServerRequest.HttpServerRequest) =>
        HttpServerRequest.toWeb(request).pipe(
          Effect.flatMap((web) => Effect.promise(() => auth.handler(web))),
          Effect.map(HttpServerResponse.fromWeb),
          // A request that cannot even be turned into a web request is a
          // defect, not a credential problem: it reaches the ledger as a 500
          // rather than as a documented refusal an agent might retry.
          Effect.orDie
        )
    );
  })
);

/**
 * The whole of authentication for one gateway.
 *
 * Requires the store — the auth instance is built over the same connection pool
 * the repositories use — and the router, since the library's routes are real
 * routes. Provide it once, under the API layer.
 */
export const accessLayer = Layer.mergeAll(
  readAccessLayer,
  taskWriteAccessLayer,
  adminAccessLayer,
  authRoutesLayer
).pipe(Layer.provide(Access.layer));
