/**
 * Turning a credential into a {@link Principal} — the one place in the gateway
 * that decides who a request is.
 *
 * Three doors, one answer. A browser sends a Better Auth session cookie; the
 * system's own agents send a bearer token signed from the deployment's secret;
 * a person's integration sends an API key that person issued, in `x-api-key`.
 * All three resolve to the same three facts — the actor every write is
 * attributed to, the scope the credential is good for, and the single workspace
 * it can see — and every handler downstream reads those from the service rather
 * than from the request, so there is no second way to find out who is calling.
 *
 * **A key and a token are not the same kind of thing, and the split is on
 * purpose.** A key is a person's: stored hashed, revocable from the dashboard,
 * resolving to that person's `human` actor with the scope they chose. A token
 * is the system's: signed rather than stored, expiring in minutes, bound to a
 * run's own task. Neither is minted from the other. Revoking every key a person
 * owns stops that person's integrations and leaves every worker on the board
 * running, and that is a property of these being two paths rather than a rule
 * anybody has to keep.
 *
 * **The workspace is never in a path or a body.** It comes off the credential
 * and nowhere else, which is what makes "a cross-workspace read returns
 * nothing" a property of the system rather than a rule handlers remember: a
 * caller cannot name a workspace, so a repository can only ever be given the
 * one the credential proved.
 *
 * **The scheme record is for OpenAPI; the resolution reads the request.** The
 * contract declares each middleware over two named schemes so the spec can say
 * which credential an operation takes, and the builder then runs the schemes in
 * order, keeping the *last* failure when all of them fail. Resolving per scheme
 * would therefore answer a bad bearer token with "no session cookie", which is
 * the wrong sentence to hand somebody debugging at midnight. So both schemes
 * call this, it looks at whichever credential is actually present, and the
 * reason a caller gets back is the reason it was refused.
 */

import {
  API_KEY_HEADER,
  type ApiScope,
  boundTaskId,
  Forbidden,
  type PrincipalShape,
  scopeReaches,
  TooManyRequests,
  Unauthorized,
} from "@workspace/api";
import type { WorkspaceRepo } from "@workspace/db";
import { Actor, UserId, WorkspaceId } from "@workspace/domain";
import type { TokenSigner } from "@workspace/token";
import { type Context, Effect } from "effect";
import { HttpRouter, HttpServerRequest } from "effect/unstable/http";
import { type AuthInstance, resolveApiKey, USER_CEILING } from "./api-key";
import {
  type AuthOutcome,
  type AuthRecord,
  type AuthScheme,
  recordAuth,
} from "./record";

/**
 * The cookie the dashboard sends. Spelled here exactly as
 * `@workspace/api`'s session scheme spells it, because the two have to agree
 * for the document to describe the door the gateway actually opens.
 *
 * Two spellings, one door. Better Auth renames its cookie with the `__Secure-`
 * prefix the moment its base URL is https — which every deployment's is — so a
 * gateway that knew only the bare name would find nothing on a perfectly valid
 * request and refuse it for having no credential at all.
 */
const SESSION_COOKIE = "better-auth.session_token";
const SECURE_SESSION_COOKIE = `__Secure-${SESSION_COOKIE}`;

/** The session cookie on this request under whichever name it arrived. */
const sessionCookieOf = (
  cookies: Readonly<Record<string, string | undefined>>
) => cookies[SECURE_SESSION_COOKIE] ?? cookies[SESSION_COOKIE];

/** The path parameter every task-scoped route in the contract nests below. */
const TASK_PARAM = "taskId";

/** The authorization scheme a machine credential arrives under. */
const BEARER_PREFIX = "bearer ";

/**
 * Why a request was refused, as a closed set. It is a field on the request
 * event and the string a caller reads, and those being the same string is the
 * point: what an operator groups by is what the client was told.
 */
const REASONS = {
  ambiguousWorkspace: "ambiguous_workspace",
  insufficientScope: "insufficient_scope",
  noCredential: "no_credential",
  noSession: "no_session",
  notAMember: "workspace_not_member",
  noWorkspace: "no_workspace",
  taskNotOwned: "task_not_owned",
  unscopedRoute: "unscoped_route",
} as const;

/**
 * The scope a signed-in person holds. The same value a key is checked against
 * before it is believed, which is what makes "a key carries its issuer's
 * permissions and no more" one comparison rather than two agreeing constants.
 */
const SESSION_SCOPE: ApiScope = USER_CEILING;

/** The ids an actor carries, flattened for the request event. */
const identityOf = (actor: Actor) =>
  Actor.match(actor, {
    human: (self) => ({ runId: null, sessionId: null, userId: self.userId }),
    manager: (self) => ({ runId: null, sessionId: null, userId: self.userId }),
    orchestrator: (self) => ({
      runId: self.runId ?? null,
      sessionId: null,
      userId: null,
    }),
    system: () => ({ runId: null, sessionId: null, userId: null }),
    worker_run: (self) => ({
      runId: self.runId,
      sessionId: self.sessionId,
      userId: null,
    }),
  });

/** Nothing resolved: every identity field is absent rather than defaulted. */
const NOBODY = {
  actorKind: null,
  authBoundTaskId: null,
  authScope: null,
  runId: null,
  sessionId: null,
  userId: null,
  workspaceId: null,
} as const;

/** The verdict for one request, whichever way it went. */
const recordOf = (options: {
  readonly outcome: AuthOutcome;
  readonly principal: PrincipalShape | null;
  readonly reason: string | null;
  readonly required: ApiScope;
  readonly scheme: AuthScheme;
}): AuthRecord => {
  const { principal } = options;
  const who =
    principal === null
      ? NOBODY
      : {
          actorKind: principal.actor.kind,
          authBoundTaskId: boundTaskId(principal),
          authScope: principal.scope,
          workspaceId: principal.workspaceId,
          ...identityOf(principal.actor),
        };
  return {
    authOutcome: options.outcome,
    authReason: options.reason,
    authRequired: options.required,
    authScheme: options.scheme,
    ...who,
  };
};

/** What a resolution step needs to describe itself on the way out. */
interface Attempt {
  readonly required: ApiScope;
  readonly scheme: AuthScheme;
}

/** How a refusal is spelled on the wire, keyed by the outcome it is filed as. */
const failureOf = (outcome: AuthOutcome, attempt: Attempt, reason: string) => {
  if (outcome === "forbidden") {
    return new Forbidden({ reason, required: attempt.required });
  }
  return outcome === "rate_limited"
    ? new TooManyRequests({ reason })
    : new Unauthorized({ reason });
};

/** Files the refusal, then fails with it. Both, always — a 401 nobody counted is a 401 nobody fixes. */
const deny = (
  attempt: Attempt,
  reason: string,
  options?: {
    readonly as?: Exclude<AuthOutcome, "granted">;
    readonly principal?: PrincipalShape;
  }
) => {
  const outcome = options?.as ?? "unauthorized";
  return Effect.andThen(
    recordAuth(
      recordOf({
        outcome,
        principal: options?.principal ?? null,
        reason,
        required: attempt.required,
        scheme: attempt.scheme,
      })
    ),
    Effect.fail(failureOf(outcome, attempt, reason))
  );
};

/** The bearer token on this request, or the empty string when there is none. */
const bearerOf = (headers: Readonly<Record<string, string | undefined>>) => {
  const authorization = headers.authorization ?? "";
  return authorization.toLowerCase().startsWith(BEARER_PREFIX)
    ? authorization.slice(BEARER_PREFIX.length).trim()
    : "";
};

/** The user API key on this request, or the empty string when there is none. */
const apiKeyOf = (headers: Readonly<Record<string, string | undefined>>) =>
  headers[API_KEY_HEADER]?.trim() ?? "";

/**
 * Which door the request came to, judged by what it actually carried.
 *
 * The order is the specificity order rather than a preference: each credential
 * has a header of its own, so a request carrying two has said two things and
 * the one it is judged by should not depend on which check ran first. A key is
 * read before a token because it is the one a person had to go and create — if
 * somebody sent both, the deliberate one is the key.
 */
const schemeOf = (options: {
  readonly apiKey: string;
  readonly cookie: string | undefined;
  readonly token: string;
}): AuthScheme => {
  if (options.apiKey !== "") {
    return "api_key";
  }
  if (options.token !== "") {
    return "bearer";
  }
  return options.cookie === undefined ? "none" : "session";
};

/** Better Auth reads the request's own headers, signature and all, so it is handed them whole. */
const headersOf = (request: HttpServerRequest.HttpServerRequest) =>
  new Headers({ ...request.headers });

/**
 * Resolves credentials to principals for one gateway. Built over the auth
 * instance and the signer, so a request pays for neither.
 */
export interface PrincipalResolver {
  /**
   * Who this request is, once it has proved it may perform an operation at
   * `required`. Fails {@link Unauthorized} when nothing resolves,
   * {@link Forbidden} when something did and does not reach, and
   * {@link TooManyRequests} when a user's key is over its own quota.
   */
  readonly resolve: (
    required: ApiScope
  ) => Effect.Effect<
    PrincipalShape,
    Unauthorized | Forbidden | TooManyRequests,
    HttpServerRequest.HttpServerRequest | HttpRouter.RouteContext
  >;
}

/** What {@link makePrincipalResolver} is built over. */
export interface ResolverOptions {
  readonly auth: AuthInstance;
  readonly tokens: TokenSigner;
  /**
   * The membership read a key is checked against. A cookie can be handed back
   * to the auth library, which reads memberships off the session itself; a key
   * names a user and nothing more, so the workspace it claims has to be
   * verified against the database.
   */
  readonly workspaces: Pick<
    Context.Service.Shape<typeof WorkspaceRepo>,
    "membershipsOf"
  >;
}

/**
 * The workspace a session speaks for.
 *
 * The active organization on the session is the answer when there is one, but
 * it is checked against the memberships the request can actually prove rather
 * than trusted on its own: a person removed from a workspace keeps a session
 * naming it, and that session must stop opening its board on the next request,
 * not on the next login. One indexed read per cookie-authenticated request buys
 * that, and cookie traffic is the dashboard's alone.
 */
const workspaceOfSession = (options: {
  readonly active: string | null | undefined;
  readonly attempt: Attempt;
  readonly auth: AuthInstance;
  readonly headers: Headers;
}) =>
  Effect.gen(function* () {
    const organizations = yield* Effect.promise(() =>
      options.auth.api.listOrganizations({ headers: options.headers })
    );
    const ids = organizations.map((organization) => organization.id);

    if (options.active !== null && options.active !== undefined) {
      return ids.includes(options.active)
        ? WorkspaceId.make(options.active)
        : yield* deny(options.attempt, REASONS.notAMember, {
            as: "forbidden",
          });
    }
    if (ids.length === 0) {
      return yield* deny(options.attempt, REASONS.noWorkspace);
    }
    // More than one and none chosen is a question only the caller can answer,
    // and picking for them would silently file work in the wrong workspace.
    const [only] = ids;
    return ids.length === 1 && only !== undefined
      ? WorkspaceId.make(only)
      : yield* deny(options.attempt, REASONS.ambiguousWorkspace);
  });

/**
 * Builds the resolver. The auth instance and the signer are captured once,
 * because the access middleware the contract declares provides `Principal` and
 * requires nothing — which is the right shape: what a request may reach must
 * not depend on what a request happens to carry in its context.
 */
export const makePrincipalResolver = (
  options: ResolverOptions
): PrincipalResolver => {
  /** A machine credential: signed claims, verified from the secret, nothing looked up. */
  const fromToken = (attempt: Attempt, token: string) =>
    options.tokens.verify(token).pipe(
      Effect.map(
        (claims): PrincipalShape => ({
          actor: claims.actor,
          scope: claims.scope,
          workspaceId: claims.workspaceId,
        })
      ),
      Effect.catchTag("TokenRejected", (rejected) =>
        deny(attempt, `token_${rejected.reason}`)
      )
    );

  /** A person's credential: the library verifies the cookie, we read the workspace off it. */
  const fromSession = (
    attempt: Attempt,
    request: HttpServerRequest.HttpServerRequest
  ) =>
    Effect.gen(function* () {
      const headers = headersOf(request);
      const session = yield* Effect.promise(() =>
        options.auth.api.getSession({ headers })
      );
      if (session === null) {
        return yield* deny(attempt, REASONS.noSession);
      }
      const workspaceId = yield* workspaceOfSession({
        active: session.session.activeOrganizationId,
        attempt,
        auth: options.auth,
        headers,
      });
      return {
        actor: Actor.cases.human.make({
          userId: UserId.make(session.user.id),
        }),
        scope: SESSION_SCOPE,
        workspaceId,
      } satisfies PrincipalShape;
    });

  /**
   * A person's other credential: a key they issued for themselves, verified
   * against a stored hash rather than a signature.
   *
   * The verdict comes back from `./api-key`, which knows the plugin; the
   * refusal is spelled here, which knows how a refusal is filed. A spent quota
   * is the one that is neither a 401 nor a 403 — the credential is good and the
   * repair is to wait, so it is filed as its own outcome and answered 429.
   */
  const fromApiKey = (attempt: Attempt, key: string) =>
    Effect.gen(function* () {
      const verdict = yield* resolveApiKey({
        auth: options.auth,
        key,
        workspaces: options.workspaces,
      });
      if (verdict.kind === "resolved") {
        return verdict.principal;
      }
      if (verdict.kind === "spent") {
        return yield* deny(attempt, verdict.reason, { as: "rate_limited" });
      }
      return yield* deny(attempt, verdict.reason, {
        as: verdict.forbidden ? "forbidden" : "unauthorized",
      });
    });

  /**
   * A run's token writes on its own task and reads everywhere else. The check
   * is here, once, against the `:taskId` the contract nests every task-owned
   * route below — which is why the contract nests them.
   */
  const checkBinding = (attempt: Attempt, principal: PrincipalShape) =>
    Effect.gen(function* () {
      const bound = boundTaskId(principal);
      if (bound === null || attempt.required === "read") {
        return principal;
      }
      const params = yield* HttpRouter.params;
      const onTask = params[TASK_PARAM];
      if (onTask === undefined) {
        // A write that is not about one task — filing a project, opening a new
        // ticket — is not this run's to make, whatever its token says.
        return yield* deny(attempt, REASONS.unscopedRoute, {
          as: "forbidden",
          principal,
        });
      }
      return onTask === bound
        ? principal
        : yield* deny(attempt, REASONS.taskNotOwned, {
            as: "forbidden",
            principal,
          });
    });

  const resolve = Effect.fn("Gateway.resolvePrincipal")(function* (
    required: ApiScope
  ) {
    const request = yield* HttpServerRequest.HttpServerRequest;
    const apiKey = apiKeyOf(request.headers);
    const token = bearerOf(request.headers);
    const cookie = sessionCookieOf(request.cookies);
    const scheme = schemeOf({ apiKey, cookie, token });
    const attempt = { required, scheme } as const;

    if (scheme === "none") {
      return yield* deny(attempt, REASONS.noCredential);
    }

    const principal = yield* {
      api_key: () => fromApiKey(attempt, apiKey),
      bearer: () => fromToken(attempt, token),
      session: () => fromSession(attempt, request),
    }[scheme]();

    if (!scopeReaches(principal.scope, required)) {
      return yield* deny(attempt, REASONS.insufficientScope, {
        as: "forbidden",
        principal,
      });
    }

    const bound = yield* checkBinding(attempt, principal);
    yield* recordAuth(
      recordOf({
        outcome: "granted",
        principal: bound,
        reason: null,
        required,
        scheme,
      })
    );
    return bound;
  });

  return { resolve };
};
