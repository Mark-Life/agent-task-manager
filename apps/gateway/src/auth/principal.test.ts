/**
 * Who a request turns out to be, against the real database.
 *
 * Nothing is mocked, because the two things worth proving are both somebody
 * else's enforcement seen from here: Better Auth really verifies the cookie it
 * signed, and a repository really refuses a row belonging to another workspace.
 * A fake session store would prove that the fake accepts what the fake issued.
 *
 * The rows these tests create are deleted afterwards — the users, the tasks,
 * and the one workspace nothing was ever written to. The seeded workspace stays
 * and so do its audit rows: the trail is append-only and references the
 * workspace with `on delete restrict`, which is exactly why the writing half of
 * this file works there rather than in a throwaway of its own.
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { createHmac } from "node:crypto";
import { Unauthorized } from "@workspace/api";
import {
  Auth,
  NotFound,
  storeLayer,
  TaskRepo,
  WorkspaceRepo,
  withActor,
} from "@workspace/db";
import {
  Actor,
  AgentSessionId,
  RunId,
  type Task,
  type TaskId,
  UserId,
  type WorkspaceId,
} from "@workspace/domain";
import {
  Effect,
  Layer,
  ManagedRuntime,
  Redacted,
  Result,
  Schema,
} from "effect";
import {
  HttpRouter,
  HttpServerRequest,
  HttpServerResponse,
} from "effect/unstable/http";
import { makePrincipalResolver } from "./principal";
import { type AuthRecord, makeRequestAuth, RequestAuth } from "./record";
import { tokenSignerFrom } from "./tokens";

/** Reported as `application_name`, so `pg_stat_activity` names this process. */
const APPLICATION_NAME = "gateway-auth-test";

/** The signing secret for the tokens in this file. Never the deployment's. */
const SECRET = Redacted.make("gateway-auth-test-secret");

/** The cookie name the contract's session scheme declares. */
const SESSION_COOKIE = "better-auth.session_token";

/** A URL only used to make a well-formed request object. */
const ORIGIN = "http://gateway.test";

/** The route a task-scoped request matched, as the router would have matched it. */
const TASK_ROUTE = HttpRouter.route(
  "POST",
  "/tasks/:taskId/comments",
  HttpServerResponse.empty()
);

/** Something the test setup needed and the database did not have. */
class SetupFailed extends Schema.TaggedErrorClass<SetupFailed>()(
  "AuthTest.SetupFailed",
  { detail: Schema.String }
) {}

const runtime = ManagedRuntime.make(
  Layer.mergeAll(storeLayer({ applicationName: APPLICATION_NAME }))
);

const tokens = tokenSignerFrom(SECRET);

const auth = await runtime.runPromise(Effect.map(Auth, (self) => self));
const authContext = await auth.$context;

/** Better Auth signs its session cookie; a test that sends an unsigned one proves nothing. */
const signedCookie = (token: string) => {
  const signature = createHmac("sha256", authContext.secret)
    .update(token)
    .digest("base64");
  return encodeURIComponent(`${token}.${signature}`);
};

/**
 * A person with a real session in a workspace.
 *
 * Their organization is passed in rather than created: our tables reference it
 * with `on delete restrict` and the audit trail is append-only, so a workspace
 * that has ever been written to cannot be erased afterwards. The seeded
 * workspace is where the writes go; a throwaway one is only for the person who
 * never writes.
 */
const makePerson = async (label: string, workspaceId: WorkspaceId) => {
  const user = await authContext.internalAdapter.createUser(
    { email: `${label}-${Date.now()}@gateway.test`, name: label },
    { method: "admin" }
  );
  await auth.api.addMember({
    body: { organizationId: workspaceId, role: "owner", userId: user.id },
  });
  const session = await authContext.internalAdapter.createSession(
    user.id,
    false,
    { activeOrganizationId: workspaceId }
  );
  return {
    cookie: `${SESSION_COOKIE}=${signedCookie(session.token)}`,
    sessionToken: session.token,
    userId: user.id,
    workspaceId,
  };
};

/** A workspace of their own, for the person whose whole job is to be elsewhere. */
const makeOwnWorkspace = async (label: string, cookie: string) => {
  const organization = await auth.api.createOrganization({
    body: { name: label, slug: `${label}-${Date.now()}` },
    headers: new Headers({ cookie }),
  });
  if (organization === null || organization === undefined) {
    throw new Error(`could not create a workspace for ${label}`);
  }
  return organization.id as WorkspaceId;
};

const resolver = makePrincipalResolver({ auth, tokens });

/** One request at the door: what it was told, and what the request event was told. */
const knock = (options: {
  readonly bearer?: string;
  readonly cookie?: string;
  readonly params?: Readonly<Record<string, string>>;
  readonly required: "read" | "task-write" | "admin";
}) =>
  Effect.gen(function* () {
    const recorder = yield* makeRequestAuth;
    const headers: Record<string, string> = {};
    if (options.bearer !== undefined) {
      headers.authorization = `Bearer ${options.bearer}`;
    }
    if (options.cookie !== undefined) {
      headers.cookie = options.cookie;
    }

    const outcome = yield* Effect.result(
      resolver.resolve(options.required)
    ).pipe(
      Effect.provideService(
        HttpServerRequest.HttpServerRequest,
        HttpServerRequest.fromWeb(new Request(`${ORIGIN}/tasks`, { headers }))
      ),
      Effect.provideService(
        HttpRouter.RouteContext,
        HttpRouter.RouteContext.of({
          params: options.params ?? {},
          route: TASK_ROUTE,
        })
      ),
      Effect.provideService(RequestAuth, recorder)
    );

    const record = yield* recorder.get;
    return { outcome, record };
  });

/** The record a request left, or a failure saying it left none. */
const recordOf = (record: AuthRecord | null) => {
  if (record === null) {
    throw new Error("the request left no record of its credential");
  }
  return record;
};

let alice: Awaited<ReturnType<typeof makePerson>>;
let bob: Awaited<ReturnType<typeof makePerson>>;
let owned: Task;
let other: Task;
let runToken: string;

const asAlice = () =>
  withActor(Actor.cases.human.make({ userId: UserId.make(alice.userId) }));

beforeAll(async () => {
  const seeded = await runtime.runPromise(
    Effect.gen(function* () {
      const workspaces = yield* WorkspaceRepo;
      const [first] = yield* workspaces.list();
      return first === undefined
        ? yield* Effect.fail(
            new SetupFailed({ detail: "run `bun run db:seed` first" })
          )
        : first.id;
    })
  );

  // Alice writes, so she works in the seeded workspace: the audit rows her
  // tasks leave behind outlive this test file and pin the workspace in place.
  alice = await makePerson("alice", seeded);

  const bobsWorkspace = await makePerson("bob", seeded).then(
    async (person) => ({
      person,
      workspaceId: await makeOwnWorkspace("bobsplace", person.cookie),
    })
  );
  bob = { ...bobsWorkspace.person, workspaceId: bobsWorkspace.workspaceId };

  const filed = await runtime.runPromise(
    Effect.gen(function* () {
      const tasks = yield* TaskRepo;
      const first = yield* asAlice()(
        tasks.create({
          status: "backlog",
          title: "the run's own task",
          workspaceId: alice.workspaceId,
        })
      );
      const second = yield* asAlice()(
        tasks.create({
          status: "backlog",
          title: "somebody else's ticket",
          workspaceId: alice.workspaceId,
        })
      );
      return [first, second] as const;
    })
  );
  [owned, other] = filed;

  runToken = await Effect.runPromise(
    tokens.mint({
      actor: Actor.cases.worker_run.make({
        runId: RunId.make("0199a000-0000-7000-8000-0000000000a1"),
        sessionId: AgentSessionId.make("0199a000-0000-7000-8000-0000000000a2"),
        taskId: owned.id,
      }),
      scope: "task-write",
      ttl: "1 hour",
      workspaceId: alice.workspaceId,
    })
  );
});

afterAll(async () => {
  await runtime.runPromise(
    Effect.gen(function* () {
      const tasks = yield* TaskRepo;
      for (const task of [owned, other]) {
        yield* asAlice()(
          tasks.delete({ id: task.id, workspaceId: alice.workspaceId })
        );
      }
    })
  );
  // Only the workspace nothing was written to can go; the seeded one stays,
  // held in place by the audit rows these tests deliberately leave behind.
  await auth.api.deleteOrganization({
    body: { organizationId: bob.workspaceId },
    headers: new Headers({ cookie: bob.cookie }),
  });
  await Promise.all(
    [alice, bob].map((person) =>
      authContext.internalAdapter.deleteUser(person.userId)
    )
  );
  await runtime.dispose();
});

describe("a browser session", () => {
  test("resolves to the person who holds it, in their own workspace", async () => {
    const { outcome, record } = await runtime.runPromise(
      knock({ cookie: alice.cookie, required: "read" })
    );

    if (!Result.isSuccess(outcome)) {
      throw new Error(`expected a principal, got ${outcome.failure._tag}`);
    }
    expect(outcome.success.actor.kind).toBe("human");
    expect(outcome.success.workspaceId).toBe(alice.workspaceId);
    expect(recordOf(record).authOutcome).toBe("granted");
    expect(recordOf(record).authScheme).toBe("session");
    expect(recordOf(record).userId).toBe(UserId.make(alice.userId));
  });

  test("reaches the destructive end, which is what an operator's dashboard needs", async () => {
    const { outcome } = await runtime.runPromise(
      knock({ cookie: alice.cookie, required: "admin" })
    );

    expect(Result.isSuccess(outcome)).toBe(true);
  });

  test("is refused when the cookie was not signed by this deployment", async () => {
    const { outcome, record } = await runtime.runPromise(
      knock({
        cookie: `${SESSION_COOKIE}=${encodeURIComponent(`${alice.sessionToken}.forged`)}`,
        required: "read",
      })
    );

    expect(Result.isFailure(outcome)).toBe(true);
    expect(recordOf(record).authReason).toBe("no_session");
  });
});

describe("a run's token", () => {
  test("writes on the task it was dispatched for", async () => {
    const { outcome, record } = await runtime.runPromise(
      knock({
        bearer: runToken,
        params: { taskId: owned.id },
        required: "task-write",
      })
    );

    if (!Result.isSuccess(outcome)) {
      throw new Error(`expected a principal, got ${outcome.failure._tag}`);
    }
    expect(outcome.success.actor.kind).toBe("worker_run");
    expect(outcome.success.workspaceId).toBe(alice.workspaceId);
    expect(recordOf(record).authBoundTaskId).toBe(owned.id);
  });

  test("is refused on anybody else's task", async () => {
    const { outcome, record } = await runtime.runPromise(
      knock({
        bearer: runToken,
        params: { taskId: other.id },
        required: "task-write",
      })
    );

    expect(Result.isFailure(outcome)).toBe(true);
    expect(recordOf(record).authOutcome).toBe("forbidden");
    expect(recordOf(record).authReason).toBe("task_not_owned");
  });

  test("is refused on a write that is about no task at all", async () => {
    const { outcome, record } = await runtime.runPromise(
      knock({ bearer: runToken, required: "task-write" })
    );

    expect(Result.isFailure(outcome)).toBe(true);
    expect(recordOf(record).authReason).toBe("unscoped_route");
  });

  test("reads the rest of the board, which is how it knows what it works alongside", async () => {
    const { outcome } = await runtime.runPromise(
      knock({
        bearer: runToken,
        params: { taskId: other.id },
        required: "read",
      })
    );

    expect(Result.isSuccess(outcome)).toBe(true);
  });

  test("does not reach the destructive end", async () => {
    const { outcome, record } = await runtime.runPromise(
      knock({
        bearer: runToken,
        params: { taskId: owned.id },
        required: "admin",
      })
    );

    expect(Result.isFailure(outcome)).toBe(true);
    expect(recordOf(record).authReason).toBe("insufficient_scope");
  });
});

describe("a token that does not resolve", () => {
  test("leaves a record naming the scope it wanted and why it failed", async () => {
    const expired = await Effect.runPromise(
      tokens.mint({
        actor: Actor.cases.human.make({ userId: UserId.make(alice.userId) }),
        scope: "read",
        ttl: "0 seconds",
        workspaceId: alice.workspaceId,
      })
    );
    const { outcome, record } = await runtime.runPromise(
      knock({ bearer: expired, required: "read" })
    );

    if (!Result.isFailure(outcome)) {
      throw new Error("an expired token was accepted");
    }
    expect(outcome.failure).toBeInstanceOf(Unauthorized);
    expect(recordOf(record).authReason).toBe("token_expired");
    expect(recordOf(record).authRequired).toBe("read");
    expect(recordOf(record).authScheme).toBe("bearer");
    expect(recordOf(record).authScope).toBeNull();
  });

  test("records a malformed one the same way, rather than dropping it", async () => {
    const { outcome, record } = await runtime.runPromise(
      knock({ bearer: "not-a-token-at-all", required: "read" })
    );

    expect(Result.isFailure(outcome)).toBe(true);
    expect(recordOf(record).authReason).toBe("token_malformed");
  });

  test("records the absence of a credential too", async () => {
    const { outcome, record } = await runtime.runPromise(
      knock({ required: "read" })
    );

    expect(Result.isFailure(outcome)).toBe(true);
    expect(recordOf(record).authScheme).toBe("none");
    expect(recordOf(record).authReason).toBe("no_credential");
  });

  test("resolves normally in a process that collects no request event", async () => {
    const outcome = await runtime.runPromise(
      Effect.result(resolver.resolve("read")).pipe(
        Effect.provideService(
          HttpServerRequest.HttpServerRequest,
          HttpServerRequest.fromWeb(
            new Request(`${ORIGIN}/tasks`, {
              headers: { cookie: alice.cookie },
            })
          )
        ),
        Effect.provideService(
          HttpRouter.RouteContext,
          HttpRouter.RouteContext.of({ params: {}, route: TASK_ROUTE })
        )
      )
    );

    expect(Result.isSuccess(outcome)).toBe(true);
  });
});

describe("the workspace on the credential", () => {
  test("is the only one it can read, so another workspace's task is simply absent", async () => {
    const bobsToken = await Effect.runPromise(
      tokens.mint({
        actor: Actor.cases.human.make({ userId: UserId.make(bob.userId) }),
        scope: "read",
        ttl: "1 hour",
        workspaceId: bob.workspaceId,
      })
    );
    const { outcome } = await runtime.runPromise(
      knock({ bearer: bobsToken, required: "read" })
    );
    if (!Result.isSuccess(outcome)) {
      throw new Error("bob's own token was refused");
    }
    expect(outcome.success.workspaceId).toBe(bob.workspaceId);

    const found = await runtime.runPromise(
      Effect.result(
        Effect.gen(function* () {
          const tasks = yield* TaskRepo;
          return yield* tasks.byId({
            id: owned.id as TaskId,
            workspaceId: outcome.success.workspaceId,
          });
        })
      )
    );

    if (!Result.isFailure(found)) {
      throw new Error("a task from another workspace was returned");
    }
    expect(found.failure).toBeInstanceOf(NotFound);
  });
});
