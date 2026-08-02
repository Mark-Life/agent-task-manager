/**
 * The run surface over real HTTP and a real Postgres.
 *
 * Sessions, runs and run commands share one fixture and one server because they
 * are one surface: everything here hangs off `/tasks/:taskId`, and what is
 * worth testing is precisely what that nesting and the store together promise —
 * that a session or a run under another task is invisible, that a timeline
 * comes back in `seq` order and pages without gaps, and that an intent lands as
 * a row naming who asked for it.
 *
 * The requests go over a real socket, against a server bound to an ephemeral
 * port and torn down with the layer scope. Routing, the access middleware, the
 * schema decode and the response encode are all the ones the gateway serves
 * with, and the event stream is a real chunked response rather than a promise
 * of one. Only the credential is a stand-in: resolving one is not built yet,
 * and a test that skipped the access middleware would prove the handlers work
 * on a request that cannot arrive.
 */

import { afterAll, beforeAll, expect, test } from "bun:test";
import { BunHttpServer, BunServices } from "@effect/platform-bun";
import {
  AdminAccess,
  Api,
  Principal,
  type PrincipalShape,
  ReadAccess,
  TaskWriteAccess,
} from "@workspace/api";
import {
  AgentSessionRepo,
  CurrentActor,
  RunEventRepo,
  RunRepo,
  storeLayer,
  TaskRepo,
  WorkspaceRepo,
  withActor,
} from "@workspace/db";
import {
  Actor,
  type AgentSessionId,
  newTaskId,
  type Run,
  type RunId,
  type Task,
  type TaskId,
  type WorkspaceId,
} from "@workspace/domain";
import { Context, DateTime, Effect, Exit, Layer, Schema, Scope } from "effect";
import { HttpRouter, HttpServer } from "effect/unstable/http";
import { HttpApiBuilder } from "effect/unstable/httpapi";
import { RunEventNotices } from "../sse";
import { handlersLayer } from ".";

/** Reported as `application_name`, so `pg_stat_activity` names this process. */
const APPLICATION_NAME = "gateway-run-surface-test";

/** The server binds an ephemeral port, so a suite never collides with a running gateway. */
const EPHEMERAL_PORT = 0;

/** The address a server bound to a TCP port reports, or nothing to test against. */
class NotListening extends Schema.TaggedErrorClass<NotListening>()(
  "RunSurfaceTest.NotListening",
  {}
) {}

/** The database has no workspace, so nothing below it can be written. */
class NoWorkspace extends Schema.TaggedErrorClass<NoWorkspace>()(
  "RunSurfaceTest.NoWorkspace",
  {}
) {}

const store = storeLayer({ applicationName: APPLICATION_NAME });

/** Whoever writes here. `system` so no user row has to exist for the test. */
const actor = Actor.cases.system.make({ reason: APPLICATION_NAME });

/** Runs a program that needs the store and an actor to write as. */
const runStore = <A, E>(
  program: Effect.Effect<A, E, CurrentActor | Layer.Success<typeof store>>
) => Effect.runPromise(program.pipe(withActor(actor), Effect.provide(store)));

/**
 * A server that answers as one caller.
 *
 * The three access middlewares resolve to the same principal, which is what
 * makes this a test of the handlers rather than of the credentials: the scope
 * check and the task binding belong to the middleware, and stubbing them here
 * keeps a change in either from being felt as a failure in a run command.
 */
const gatewayLayer = (workspace: WorkspaceId) => {
  const principal: PrincipalShape = {
    actor,
    scope: "admin",
    workspaceId: workspace,
  };
  // A security middleware wraps the endpoint rather than answering it: what it
  // returns is the response, so a resolved credential is *provided into* the
  // handler and never handed back. Returning the principal instead compiles
  // against nothing and fails where the response is built.
  const grant = <A, E, R>(handler: Effect.Effect<A, E, R>) =>
    Effect.provideService(handler, Principal, principal);
  const access = Layer.mergeAll(
    Layer.succeed(
      ReadAccess,
      ReadAccess.of({ readToken: grant, sessionCookie: grant })
    ),
    Layer.succeed(
      TaskWriteAccess,
      TaskWriteAccess.of({ sessionCookie: grant, taskWriteToken: grant })
    ),
    Layer.succeed(
      AdminAccess,
      AdminAccess.of({ adminToken: grant, sessionCookie: grant })
    )
  );
  const services = Layer.mergeAll(access, RunEventNotices.layer).pipe(
    Layer.provideMerge(Layer.merge(CurrentActor.layer(actor), store))
  );
  // Once, and once is enough: every group takes its repositories while its
  // layer is being built, so nothing is left asking for one per request.
  const api = HttpApiBuilder.layer(Api).pipe(
    Layer.provide(handlersLayer),
    Layer.provide(services)
  );
  return HttpRouter.serve(api).pipe(
    Layer.provideMerge(BunHttpServer.layer({ port: EPHEMERAL_PORT })),
    Layer.provide(BunServices.layer)
  );
};

let workspaceId: WorkspaceId;
let origin: string;
let serverScope: Scope.Closeable;
const createdTaskIds: TaskId[] = [];

beforeAll(async () => {
  workspaceId = await runStore(
    Effect.gen(function* () {
      const workspaces = yield* WorkspaceRepo;
      const [workspace] = yield* workspaces.list();
      if (workspace === undefined) {
        return yield* Effect.fail(new NoWorkspace());
      }
      return workspace.id;
    })
  );
  serverScope = await Effect.runPromise(Scope.make());
  origin = await Effect.runPromise(
    Effect.gen(function* () {
      const context = yield* Layer.build(gatewayLayer(workspaceId));
      const { address } = Context.get(context, HttpServer.HttpServer);
      if (address._tag !== "TcpAddress") {
        return yield* Effect.fail(new NotListening());
      }
      return `http://localhost:${address.port}`;
    }).pipe(Effect.provideService(Scope.Scope, serverScope))
  );
});

afterAll(async () => {
  // Closing the scope stops the server and drains the pool it was built over,
  // so a suite that ran leaves nothing listening and nothing connected.
  await Effect.runPromise(Scope.close(serverScope, Exit.void));
  await runStore(
    Effect.gen(function* () {
      const tasks = yield* TaskRepo;
      for (const id of createdTaskIds.splice(0)) {
        // Sessions, runs, run events and commands all hang off the task by a
        // cascading key, so one delete takes the whole fixture.
        yield* tasks.delete({ id, workspaceId }).pipe(Effect.ignore);
      }
    })
  );
});

/** A bearer header, because the security scheme is what selects the middleware. */
const AUTHORIZED = { authorization: "Bearer run-surface-test" };

const get = (path: string) =>
  fetch(`${origin}${path}`, { headers: AUTHORIZED });

const post = (path: string, body: unknown) =>
  fetch(`${origin}${path}`, {
    body: JSON.stringify(body),
    headers: { ...AUTHORIZED, "content-type": "application/json" },
    method: "POST",
  });

/** A task, remembered so the teardown erases it and everything under it. */
const makeTask = (title: string) =>
  runStore(
    Effect.gen(function* () {
      const tasks = yield* TaskRepo;
      const task = yield* tasks.create({ title, workspaceId });
      createdTaskIds.push(task.id);
      return task;
    })
  );

const openSession = (taskId: TaskId) =>
  runStore(
    Effect.gen(function* () {
      const sessions = yield* AgentSessionRepo;
      return yield* sessions.open({
        provider: "claude",
        subject: { id: taskId, kind: "task" },
        workspaceId,
      });
    })
  );

const failSession = (id: AgentSessionId, errorMessage: string) =>
  runStore(
    Effect.gen(function* () {
      const sessions = yield* AgentSessionRepo;
      return yield* sessions.fail({ errorMessage, id, workspaceId });
    })
  );

const makeRun = (taskId: TaskId, agentSessionId: AgentSessionId) =>
  runStore(
    Effect.gen(function* () {
      const runs = yield* RunRepo;
      return yield* runs.create({
        agentSessionId,
        provider: "claude",
        subject: { id: taskId, kind: "task" },
        trigger: "status_change",
        workspaceId,
      });
    })
  );

const finishRun = (id: RunId) =>
  runStore(
    Effect.gen(function* () {
      const runs = yield* RunRepo;
      return yield* runs.close({ id, outcome: "done", workspaceId });
    })
  );

/**
 * Writes one line of a run's timeline. The `seq` is passed in and the calls are
 * deliberately out of order in one test below: it is the line ordinal of the
 * container's event file, not the order rows reached Postgres, and the endpoint
 * has to answer in the first order rather than the second.
 */
const appendEvent = (input: {
  readonly run: Run;
  readonly seq: number;
  readonly task: Task;
  readonly text: string;
}) =>
  runStore(
    Effect.gen(function* () {
      const events = yield* RunEventRepo;
      const occurredAt = yield* DateTime.now;
      return yield* events.append({
        occurredAt,
        payload: {
          chars: input.text.length,
          kind: "assistant_message",
          text: input.text,
        },
        runId: input.run.id,
        seq: input.seq,
        subject: { id: input.task.id, kind: "task" },
        workspaceId,
      });
    })
  );

/**
 * The line a run's timeline ends on. A stream closes when it drains one of
 * these, which is what an orderly run leaves behind — the tick that also
 * catches a run that stopped saying anything is ten seconds away and is not
 * what this suite is testing.
 */
const appendFinished = (input: {
  readonly run: Run;
  readonly seq: number;
  readonly task: Task;
}) =>
  runStore(
    Effect.gen(function* () {
      const events = yield* RunEventRepo;
      const occurredAt = yield* DateTime.now;
      return yield* events.append({
        occurredAt,
        payload: {
          costUsd: null,
          durationMs: 1,
          kind: "finished",
          outcome: "done",
          totalTokens: 0,
          turns: 1,
        },
        runId: input.run.id,
        seq: input.seq,
        subject: { id: input.task.id, kind: "task" },
        workspaceId,
      });
    })
  );

/**
 * Writes several lines one after another, in the order given. Sequential
 * because each write opens its own pool: five at once would be five, and the
 * order they land in is what one test below is about.
 */
const appendEach = (input: {
  readonly run: Run;
  readonly seqs: readonly number[];
  readonly task: Task;
}) =>
  input.seqs.reduce<Promise<unknown>>(
    (written, seq) =>
      written.then(() =>
        appendEvent({
          run: input.run,
          seq,
          task: input.task,
          text: `line ${seq}`,
        })
      ),
    Promise.resolve()
  );

/** A run with a session behind it, since every run belongs to one. */
const makeLiveRun = async (task: Task) => {
  const session = await openSession(task.id);
  return await makeRun(task.id, session.id);
};

test("a task's sessions come back newest first, failed ones included", async () => {
  const task = await makeTask("run surface: sessions");
  const first = await openSession(task.id);
  await failSession(first.id, "the container died");
  const second = await openSession(task.id);

  const response = await get(`/tasks/${task.id}/sessions`);
  expect(response.status).toBe(200);

  const sessions = (await response.json()) as {
    errorMessage: string | null;
    id: string;
    status: string;
  }[];
  expect(sessions.map((session) => session.id)).toEqual([second.id, first.id]);
  expect(sessions.map((session) => session.status)).toEqual([
    "running",
    "failed",
  ]);
  expect(sessions[1]?.errorMessage).toBe("the container died");
});

test("a session belonging to another task is absent, not forbidden", async () => {
  const mine = await makeTask("run surface: session owner");
  const other = await makeTask("run surface: session neighbour");
  const session = await openSession(other.id);

  const response = await get(`/tasks/${mine.id}/sessions/${session.id}`);
  expect(response.status).toBe(404);
});

test("listing the sessions of a task that does not exist is a 404", async () => {
  const response = await get(`/tasks/${newTaskId()}/sessions`);
  expect(response.status).toBe(404);
});

test("the transcript is not served by this build", async () => {
  const task = await makeTask("run surface: transcript");
  const session = await openSession(task.id);

  const response = await get(
    `/tasks/${task.id}/sessions/${session.id}/transcript`
  );
  expect(response.status).toBe(501);
});

test("a run belonging to another task is absent, not forbidden", async () => {
  const mine = await makeTask("run surface: run owner");
  const other = await makeTask("run surface: run neighbour");
  const run = await makeLiveRun(other);

  const response = await get(`/tasks/${mine.id}/runs/${run.id}`);
  expect(response.status).toBe(404);
});

test("a run's events page in seq order whatever order they were written", async () => {
  const task = await makeTask("run surface: timeline");
  const run = await makeLiveRun(task);
  await appendEach({ run, seqs: [3, 0, 4, 1, 2], task });

  const first = await get(`/tasks/${task.id}/runs/${run.id}/events?limit=2`);
  expect(first.status).toBe(200);
  const firstPage = (await first.json()) as {
    events: { seq: number }[];
    nextSeq: number | null;
  };
  expect(firstPage.events.map((event) => event.seq)).toEqual([0, 1]);
  expect(firstPage.nextSeq).toBe(1);

  const second = await get(
    `/tasks/${task.id}/runs/${run.id}/events?limit=2&afterSeq=${firstPage.nextSeq}`
  );
  const secondPage = (await second.json()) as {
    events: { seq: number }[];
    nextSeq: number | null;
  };
  expect(secondPage.events.map((event) => event.seq)).toEqual([2, 3]);
  expect(secondPage.nextSeq).toBe(3);

  const third = await get(
    `/tasks/${task.id}/runs/${run.id}/events?limit=2&afterSeq=${secondPage.nextSeq}`
  );
  const thirdPage = (await third.json()) as {
    events: { seq: number }[];
    nextSeq: number | null;
  };
  expect(thirdPage.events.map((event) => event.seq)).toEqual([4]);
  // A short page has reached the end of what exists, which is where a reader
  // switches to the stream rather than asking again.
  expect(thirdPage.nextSeq).toBeNull();
});

test("the stream replays from the cursor and closes on a finished run", async () => {
  const task = await makeTask("run surface: stream");
  const run = await makeLiveRun(task);
  await appendEach({ run, seqs: [0, 1], task });
  await appendFinished({ run, seq: 2, task });
  await finishRun(run.id);

  const response = await get(
    `/tasks/${task.id}/runs/${run.id}/events/stream?afterSeq=0`
  );
  expect(response.status).toBe(200);
  expect(response.headers.get("content-type")).toContain("text/event-stream");

  // Resolves only because the run has ended and the reader caught up with it.
  const body = await response.text();
  const seqs = body
    .split("\n")
    .filter((line) => line.startsWith("data:"))
    .map((line) => JSON.parse(line.slice("data:".length)) as { seq: number })
    .map((event) => event.seq);
  expect(seqs).toEqual([1, 2]);
});

test("a stop lands as a pending row naming its requester", async () => {
  const task = await makeTask("run surface: stop");
  const run = await makeLiveRun(task);

  const response = await post(`/tasks/${task.id}/commands/stop`, {
    runId: run.id,
  });
  expect(response.status).toBe(200);

  const command = (await response.json()) as {
    actorKind: string;
    consumedAt: string | null;
    id: string;
    payload: { kind: string };
    runId: string | null;
    status: string;
  };
  expect(command.payload.kind).toBe("stop");
  expect(command.status).toBe("pending");
  expect(command.consumedAt).toBeNull();
  expect(command.actorKind).toBe("system");
  expect(command.runId).toBe(run.id);

  const listed = await get(`/tasks/${task.id}/commands`);
  const commands = (await listed.json()) as { id: string }[];
  expect(commands.map((queued) => queued.id)).toContain(command.id);
});

test("a stop on a task with no live run is written anyway", async () => {
  // The refusal belongs to the orchestrator, which records it on the row with a
  // reason. Refusing here would replace an audited answer with a 4xx.
  const task = await makeTask("run surface: stop with nothing running");

  const response = await post(`/tasks/${task.id}/commands/stop`, {});
  expect(response.status).toBe(200);

  const command = (await response.json()) as {
    rejectedReason: string | null;
    runId: string | null;
    status: string;
  };
  expect(command.status).toBe("pending");
  expect(command.runId).toBeNull();
  expect(command.rejectedReason).toBeNull();
});

test("a second stop returns the intent already queued", async () => {
  const task = await makeTask("run surface: double stop");
  await makeLiveRun(task);

  const first = await post(`/tasks/${task.id}/commands/stop`, {});
  const second = await post(`/tasks/${task.id}/commands/stop`, {});
  const one = (await first.json()) as { id: string };
  const two = (await second.json()) as { id: string };
  expect(two.id).toBe(one.id);
});

test("a stop naming another task's run is refused", async () => {
  const mine = await makeTask("run surface: stop owner");
  const other = await makeTask("run surface: stop neighbour");
  const run = await makeLiveRun(other);

  const response = await post(`/tasks/${mine.id}/commands/stop`, {
    runId: run.id,
  });
  expect(response.status).toBe(404);
});

test("a rerun is an intent like any other", async () => {
  const task = await makeTask("run surface: rerun");
  await makeLiveRun(task);

  const response = await post(`/tasks/${task.id}/commands/rerun`, {});
  expect(response.status).toBe(200);
  const command = (await response.json()) as {
    payload: { kind: string };
    status: string;
  };
  expect(command.payload.kind).toBe("rerun");
  expect(command.status).toBe("pending");
});

test("a start-session carries the trigger it was asked for", async () => {
  const task = await makeTask("run surface: start session");

  const response = await post(`/tasks/${task.id}/commands/start-session`, {
    trigger: "research",
  });
  expect(response.status).toBe(200);
  const command = (await response.json()) as {
    payload: { kind: string; trigger: string };
  };
  expect(command.payload).toMatchObject({
    kind: "start_session",
    trigger: "research",
  });
});

test("commands on a task that does not exist are a 404", async () => {
  const response = await post(`/tasks/${newTaskId()}/commands/stop`, {});
  expect(response.status).toBe(404);
});
