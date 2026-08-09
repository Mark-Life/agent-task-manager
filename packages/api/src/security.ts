/**
 * Who may call an operation, declared on the operation.
 *
 * Two things live here and they are not the same thing. The **security
 * schemes** say where a credential is read from, and they are emitted into
 * `components.securitySchemes` — which is how a scoped token reaches Executor
 * and any other consumer that only ever sees the spec. The **scope** says what
 * the credential has to be good for, and it is carried by attaching one of the
 * three middlewares below to an endpoint: an operation without one does not
 * compile into a handler, so a handler cannot forget the check the way a
 * hand-written `if` at the top of a function can be forgotten.
 *
 * OpenAPI has nowhere to put a scope on a bearer scheme — only OAuth2 and
 * OpenID Connect carry scope lists — so each scope is its own named scheme over
 * the same `Authorization: Bearer` header. That is the one shape in which "this
 * operation needs a task-write token" survives the trip into a generated tool
 * description, and reading three bearer entries in the spec is a smaller cost
 * than an agent having to guess.
 *
 * Each scope is a floor, not an exact match: a token that satisfies a stricter
 * scope satisfies a looser one. `read` is every GET, `task-write` is every
 * mutation that is a piece of ordinary work, and `admin` is the destructive
 * end — deleting a project, which orphans the tasks filed under it.
 *
 * Deleting a *task* is deliberately not up here. The manager clears cards off a
 * board when it is asked to, and the choice was between a scope that says
 * "ordinary work" and a credential that could also erase a project. Which
 * actors may erase a task is then checked past the scope, against the actor the
 * credential names, where the status machine's other two answers live.
 *
 * A run's token is a `task-write` token bound to the task it was dispatched
 * for. The binding is checked against the `:taskId` path parameter, which is
 * why every task-scoped route in this contract spells that parameter exactly
 * that way and nests below it: the check then belongs to the middleware, where
 * it happens once, instead of to eight handler files.
 *
 * **Three credentials, one ladder.** A signed bearer token is the system's, a
 * session cookie is a browser's, and a user's API key is a person's — issued
 * from the dashboard, revocable there, and acting as whoever issued it. All
 * three appear on every operation, and every one of them is judged by the same
 * scope comparison, so "which routes accept a key" has the same answer as
 * "which routes accept a token": all of them, up to the scope the credential
 * was issued at. A key created at `read` cannot delete a task however it is
 * pointed; a key created at `admin` can delete a project, because the person
 * who issued it could.
 */

import { type Actor, type TaskId, WorkspaceId } from "@workspace/domain";
import { Context, Schema } from "effect";
import {
  HttpApiMiddleware,
  HttpApiSecurity,
  OpenApi,
} from "effect/unstable/httpapi";
import { Forbidden, TooManyRequests, Unauthorized } from "./errors";

/**
 * The three scopes, weakest first. The order is the containment order, so
 * "does this credential reach that endpoint" is an index comparison rather than
 * a table.
 */
export const API_SCOPES = ["read", "task-write", "admin"] as const;

/** What a credential is good for. */
export const ApiScope = Schema.Literals(API_SCOPES);
export type ApiScope = typeof ApiScope.Type;

/**
 * Whether `held` reaches an endpoint asking for `required`. Total over the
 * union and derived from {@link API_SCOPES}, so adding a scope is a change in
 * one place rather than a new branch in every comparison.
 */
export const scopeReaches = (held: ApiScope, required: ApiScope) =>
  API_SCOPES.indexOf(held) >= API_SCOPES.indexOf(required);

/** The bearer token every machine consumer carries, at each of the three scopes. */
const scopedToken = (description: string) =>
  HttpApiSecurity.bearer.pipe(
    HttpApiSecurity.annotate(OpenApi.Description, description),
    HttpApiSecurity.annotate(OpenApi.Format, "opaque")
  );

/** A token that may read the whole workspace and write nothing. */
export const ReadToken = scopedToken(
  "Bearer token scoped to reads. Every GET in this API accepts it."
);

/**
 * A token that may perform ordinary work. A worker run's token is one of these
 * bound to a single task: it writes on its own task and reads everywhere else.
 */
export const TaskWriteToken = scopedToken(
  "Bearer token scoped to writes. A run's token is bound to its own task and is refused on any other."
);

/**
 * A token that may destroy, and the one that may read a stored secret. Deleting
 * a project is the destructive half; a project's environment files are the
 * other, and they are here because a run's credential must never reach them.
 */
export const AdminToken = scopedToken(
  "Bearer token scoped to destructive operations and to stored secrets — deleting a project, and a project's environment files."
);

/**
 * The browser's side of the same door: a Better Auth session cookie, which is
 * what the dashboard sends. It appears beside the bearer scheme on every
 * operation a person can perform, which in OpenAPI reads as "either of these".
 *
 * The name is the unprefixed one on purpose. Over https the library issues the
 * same cookie as `__Secure-better-auth.session_token`, and the gateway accepts
 * either spelling; a document can only name one, so it names the one that is
 * true everywhere rather than the one that is true in production.
 */
export const SessionCookie = HttpApiSecurity.apiKey({
  in: "cookie",
  key: "better-auth.session_token",
}).pipe(
  HttpApiSecurity.annotate(
    OpenApi.Description,
    "Better Auth browser session. The dashboard's credential; machines use a bearer token."
  )
);

/**
 * The header a user's API key arrives in, and the name the document declares.
 *
 * A header of its own rather than `Authorization: Bearer`, for two reasons that
 * both come down to keeping two different credentials distinguishable. A user's
 * key is issued by a person, revocable, and speaks for that person; the bearer
 * token an agent run carries is signed by the deployment's secret, unrevocable
 * and short-lived, and speaks for the system. Sharing one header would mean the
 * gateway guessing which kind of thing it was handed, and would mean a
 * refusal's reason depending on that guess.
 *
 * The second reason is the document. OpenAPI can describe an `apiKey` scheme
 * exactly — name, location, done — so a client generated from the spec sends
 * the right header without anybody writing prose about it, which is what the
 * whole spec-as-the-interface arrangement here is for.
 */
export const API_KEY_HEADER = "x-api-key";

/** A user's API key: issued from the dashboard, revoked from the dashboard. */
export const UserApiKey = HttpApiSecurity.apiKey({
  in: "header",
  key: API_KEY_HEADER,
}).pipe(
  HttpApiSecurity.annotate(
    OpenApi.Description,
    "An API key a person issued for themselves. It acts as that person, with the scope chosen when it was created, and stops working the moment it is revoked."
  )
);

/**
 * What a key carries beyond its own secret: the scope it was issued at, and the
 * workspace it speaks in.
 *
 * It rides in the plugin's `metadata` because that is the one field a browser
 * may set at creation, which makes it *untrusted*. Neither value is believed on
 * its own — the scope is checked against the issuer's own ceiling, and the
 * workspace against the memberships the issuer holds right now, so a key naming
 * a board its owner was removed from stops opening it on the next request
 * rather than the next login.
 */
export const ApiKeyMetadata = Schema.Struct({
  scope: ApiScope,
  workspaceId: WorkspaceId,
});
export type ApiKeyMetadata = typeof ApiKeyMetadata.Type;

/** Who the request is, once a credential has been resolved. */
export interface PrincipalShape {
  /** The actor every write this request makes is attributed to. */
  readonly actor: Actor;
  /** What the credential was good for, which is at least what the endpoint asked. */
  readonly scope: ApiScope;
  /** The workspace every query is scoped to. Never a path parameter — it comes from the credential. */
  readonly workspaceId: WorkspaceId;
}

/**
 * The request's identity, provided by whichever access middleware ran.
 *
 * A service rather than an argument for the same reason `CurrentActor` is one
 * in the store: a handler that mutates without saying who did it should not
 * compile, and the audit row is written from this.
 */
export class Principal extends Context.Service<Principal, PrincipalShape>()(
  "@workspace/api/Principal"
) {}

/**
 * The single task a credential is confined to, or null for one that is not
 * confined. Reads it off the actor rather than duplicating it beside the scope,
 * because a worker run already carries the task it was dispatched for and two
 * copies of that fact are one copy too many.
 */
export const boundTaskId = (principal: PrincipalShape): TaskId | null =>
  principal.actor.kind === "worker_run" ? principal.actor.taskId : null;

/**
 * Every access middleware fails the same three ways, and provides the same one
 * thing. The 429 belongs here rather than on the endpoints that could plausibly
 * be busy, because it is the credential that is over its quota and not the
 * operation — any of them, reached with a spent key, answers the same way.
 */
const accessOptions = {
  error: [Unauthorized, Forbidden, TooManyRequests],
} as const;

/**
 * Reads. Satisfied by any credential that resolves, including a run's
 * task-bound token pointed at somebody else's task — reading the rest of the
 * board is how an agent finds out what it is working alongside.
 */
export class ReadAccess extends HttpApiMiddleware.Service<
  ReadAccess,
  { provides: Principal }
>()("@workspace/api/ReadAccess", {
  ...accessOptions,
  security: {
    readToken: ReadToken,
    sessionCookie: SessionCookie,
    userApiKey: UserApiKey,
  },
}) {}

/**
 * Ordinary work: creating and editing tasks, moving them, deleting one,
 * posting a message, steering a run, keeping a file. A run's token reaches these only
 * on its own task, and that is checked here against the `:taskId` in the path —
 * which is the floor and not the whole answer for a delete, since a run may
 * write on its own task and still may not erase it.
 */
export class TaskWriteAccess extends HttpApiMiddleware.Service<
  TaskWriteAccess,
  { provides: Principal }
>()("@workspace/api/TaskWriteAccess", {
  ...accessOptions,
  security: {
    sessionCookie: SessionCookie,
    taskWriteToken: TaskWriteToken,
    userApiKey: UserApiKey,
  },
}) {}

/**
 * The destructive end and the confidential one. Deleting a project is the
 * first: the store refuses one that still has tasks filed under it, so what
 * that guards is the workspace's own furniture rather than anybody's work.
 *
 * A project's environment files are the second, and they are here for a
 * different reason. Their content is a stored secret, an agent's own credential
 * is a `task-write` token bound to one task, and admin is the one scope that
 * ceiling can never reach — so "a run cannot ask the board for a project's
 * secrets" is enforced by the actor's ceiling rather than by a check inside a
 * handler. A run is given its own project's files on disk, by the loop, which
 * is the only path they travel.
 *
 * A person's own API key *can* be issued at this scope, and that is the
 * difference between a user credential and an agent's: it carries what the
 * person carries. Whoever issues one is handing out their own reach over the
 * destructive end and the stored secrets both, which is why the dashboard makes
 * them choose the scope rather than defaulting to it.
 */
export class AdminAccess extends HttpApiMiddleware.Service<
  AdminAccess,
  { provides: Principal }
>()("@workspace/api/AdminAccess", {
  ...accessOptions,
  security: {
    adminToken: AdminToken,
    sessionCookie: SessionCookie,
    userApiKey: UserApiKey,
  },
}) {}
