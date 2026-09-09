/**
 * The board's live stream, over real HTTP, a real Postgres and the triggers
 * that feed it.
 *
 * The claim under test is the one the dashboard rests on: a card moved in one
 * place appears on an already-open board somewhere else, and nothing asked. So
 * nothing here is stubbed but the credential — the request goes over a socket
 * to the real router, the snapshots come back as chunks of a real
 * `text/event-stream`, and the client reading them is the same derived client a
 * browser holds, decoding through the contract's own codec.
 *
 * Four things can be wrong and none of them shows up in a type.
 *
 * The trigger can be missing or too narrow, which looks exactly like a quiet
 * board. The channel name can drift from the one the migration publishes on,
 * with the same symptom. The board a subscriber is sent can disagree with the
 * board the paged endpoint answers. And a browser tab that goes away can leave
 * its listener behind, which arrives as a database out of connections rather
 * than as a bug in this file.
 *
 * So delivery is proved through an actual `NOTIFY`: the listener is proved
 * attached by reading `pg_stat_activity`, and only then is the card moved. The
 * repair tick is thirty seconds away and every wait below is ten, so anything
 * that arrives here arrived because Postgres said so.
 *
 * The cards this file files are not flagged as fixtures, and they cannot be:
 * what is being tested *is* a column listing, and a listing does not show a
 * fixture. What keeps them off anybody's board is the two walls underneath —
 * the test database, and this suite's own workspace.
 */

import { afterAll, beforeAll, expect, test } from "bun:test";
import { BunHttpServer, BunServices } from "@effect/platform-bun";
import { PgClient } from "@effect/sql-pg";
import {
  AdminAccess,
  Api,
  type BoardColumn,
  Principal,
  type PrincipalShape,
  ReadAccess,
  TaskWriteAccess,
} from "@workspace/api";
import {
  AgentSessionRepo,
  CurrentActor,
  RunRepo,
  storeLayer,
  TaskRepo,
  withActor,
} from "@workspace/db";
import { ensureFixtureWorkspace } from "@workspace/db/testing";
import {
  Actor,
  type RunId,
  type Task,
  type TaskId,
  type TaskStatus,
  UserId,
  type WorkspaceId,
} from "@workspace/domain";
import { ScopeHistory } from "@workspace/sandbox";
import {
  Context,
  Effect,
  Exit,
  Fiber,
  Layer,
  Queue,
  Schedule,
  Schema,
  Scope,
  Stream,
} from "effect";
import {
  FetchHttpClient,
  HttpClient,
  HttpClientRequest,
  HttpRouter,
  HttpServer,
} from "effect/unstable/http";
import { HttpApiBuilder, HttpApiClient } from "effect/unstable/httpapi";
import { BOARD_CHANNEL, BoardNotices } from "./board-sse";
import { handlersLayer } from "./handlers";
import { httpServerOptions } from "./layers";
import { RunEventNotices } from "./sse";

/** Reported as `application_name`, which is how the listener is found below. */
const APPLICATION_NAME = "gateway-board-stream-test";

/** The server binds an ephemeral port, so a suite never collides with a gateway. */
const EPHEMERAL_PORT = 0;

/** Long enough for a local database, short enough to fail rather than hang. */
const WAIT_TIMEOUT = "10 seconds";

/** How often the listener count is re-read while waiting for it to settle. */
const SETTLE_INTERVAL_MS = 50;

/** Enough for a whole test to finish twice over on a laptop. */
const TEST_TIMEOUT_MS = 30_000;

/** The address a server bound to a TCP port reports, or nothing to test against. */
class NotListening extends Schema.TaggedErrorClass<NotListening>()(
  "BoardStreamTest.NotListening",
  {}
) {}

/** The listener count is not what it will be yet. Retried, never reported. */
class NotSettled extends Schema.TaggedErrorClass<NotSettled>()(
  "BoardStreamTest.NotSettled",
  { expected: Schema.Int, found: Schema.Int }
) {}

const store = storeLayer({ applicationName: APPLICATION_NAME });

/** Whoever writes here. `system` so no user row has to exist for the test. */
const actor = Actor.cases.system.make({ reason: APPLICATION_NAME });

/**
 * A person, for the two writes the system actor may not make: moving a card
 * across the status machine, and erasing one. Both are deliberately a person's,
 * and a test that wrote them as the process would be testing a door that is
 * supposed to be shut.
 */
const person = Actor.cases.human.make({
  userId: UserId.make(APPLICATION_NAME),
});

const runStore = <A, E>(
  program: Effect.Effect<A, E, CurrentActor | Layer.Success<typeof store>>
) => Effect.runPromise(program.pipe(withActor(actor), Effect.provide(store)));

/**
 * A server that answers as one caller.
 *
 * The three access middlewares resolve to the same principal: resolving a real
 * credential is the middleware's claim and is tested elsewhere, and what this
 * file is about is what happens after one has been resolved — including that
 * the workspace the stream is scoped to is the one that came off it.
 */
const gatewayLayer = (workspace: WorkspaceId) => {
  const principal: PrincipalShape = {
    actor,
    scope: "admin",
    workspaceId: workspace,
  };
  const grant = <A, E, R>(handler: Effect.Effect<A, E, R>) =>
    Effect.provideService(handler, Principal, principal);
  const access = Layer.mergeAll(
    Layer.succeed(
      ReadAccess,
      ReadAccess.of({
        readToken: grant,
        sessionCookie: grant,
        userApiKey: grant,
      })
    ),
    Layer.succeed(
      TaskWriteAccess,
      TaskWriteAccess.of({
        sessionCookie: grant,
        taskWriteToken: grant,
        userApiKey: grant,
      })
    ),
    Layer.succeed(
      AdminAccess,
      AdminAccess.of({
        adminToken: grant,
        sessionCookie: grant,
        userApiKey: grant,
      })
    )
  );
  const services = Layer.mergeAll(
    access,
    BoardNotices.layer,
    RunEventNotices.layer,
    ScopeHistory.editsLayer
  ).pipe(Layer.provideMerge(Layer.merge(CurrentActor.layer(actor), store)));
  const api = HttpApiBuilder.layer(Api).pipe(
    Layer.provide(handlersLayer),
    Layer.provide(services)
  );
  return HttpRouter.serve(api).pipe(
    Layer.provideMerge(BunHttpServer.layer(httpServerOptions(EPHEMERAL_PORT))),
    Layer.provide(BunServices.layer)
  );
};

let workspaceId: WorkspaceId;
let origin: string;
let serverScope: Scope.Closeable;
const filed: TaskId[] = [];

beforeAll(async () => {
  workspaceId = await runStore(
    Effect.gen(function* () {
      const fixture = yield* ensureFixtureWorkspace({
        suite: APPLICATION_NAME,
      });
      return fixture.workspace.id;
    })
  );
  serverScope = await Effect.runPromise(Scope.make());
  origin = await Effect.runPromise(
    Effect.gen(function* () {
      const context = yield* Layer.build(gatewayLayer(workspaceId));
      const { address } = Context.get(context, HttpServer.HttpServer);
      if (address._tag !== "TcpAddress") {
        return yield* new NotListening();
      }
      return `http://localhost:${address.port}`;
    }).pipe(Effect.provideService(Scope.Scope, serverScope))
  );
});

afterAll(async () => {
  // Closing the scope stops the server, releases the listening connection and
  // drains the pool, so a suite that ran leaves nothing connected.
  await Effect.runPromise(Scope.close(serverScope, Exit.void));
  await runStore(
    Effect.gen(function* () {
      const tasks = yield* TaskRepo;
      for (const id of filed.splice(0)) {
        yield* tasks
          .delete({ id, workspaceId })
          .pipe(withActor(person), Effect.ignore);
      }
    })
  );
});

/** A card on the board, remembered so the teardown erases it. */
const fileTask = (title: string, status: TaskStatus) =>
  runStore(
    Effect.gen(function* () {
      const tasks = yield* TaskRepo;
      const task = yield* tasks.create({ status, title, workspaceId });
      filed.push(task.id);
      return task;
    })
  );

/** Moves a card, which is the write the whole feature is about hearing. */
const moveTask = (task: Task, to: TaskStatus) =>
  runStore(
    Effect.gen(function* () {
      const tasks = yield* TaskRepo;
      return yield* tasks
        .transition({ id: task.id, to, workspaceId })
        .pipe(withActor(person));
    })
  );

/** A live run on a card, which is what puts `liveRunId` on it. */
const startRun = (taskId: TaskId) =>
  runStore(
    Effect.gen(function* () {
      const sessions = yield* AgentSessionRepo;
      const runs = yield* RunRepo;
      const session = yield* sessions.open({
        provider: "claude",
        subject: { id: taskId, kind: "task" },
        workspaceId,
      });
      return yield* runs.create({
        agentSessionId: session.id,
        provider: "claude",
        subject: { id: taskId, kind: "task" },
        trigger: "status_change",
        workspaceId,
      });
    })
  );

/**
 * The backends holding a `LISTEN` for this test's application name.
 *
 * `pg_stat_activity` reports the last statement an idle backend ran, and the
 * listening connection's last statement is its `LISTEN` — so this counts the
 * thing whose leak the design is meant to prevent, not a proxy for it.
 */
const listeningBackends = () =>
  runStore(
    Effect.gen(function* () {
      const sql = yield* PgClient.PgClient;
      const rows = yield* sql`
        select pid from pg_stat_activity
        where application_name = ${APPLICATION_NAME} and query like 'LISTEN%'
      `;
      return rows.length;
    })
  );

/**
 * Blocks until the gateway's listener is demonstrably on the channel.
 *
 * `LISTEN` takes effect when its statement returns, and a subscriber that has
 * been handed its first snapshot is not yet proof of that: the snapshot comes
 * from the tick, which fires immediately and does not wait for the channel. So
 * the count is read out of the database rather than inferred, and only then is
 * anything moved.
 */
const awaitListeners = (expected: number) =>
  Effect.runPromise(
    Effect.gen(function* () {
      const found = yield* Effect.promise(listeningBackends);
      if (found !== expected) {
        return yield* new NotSettled({ expected, found });
      }
      return found;
    }).pipe(
      Effect.retry(Schedule.spaced(SETTLE_INTERVAL_MS)),
      Effect.timeout(WAIT_TIMEOUT)
    )
  );

/**
 * The board, as the browser's own client reads it: over the wire, decoded
 * through the contract's own codec rather than by reading the frames by hand.
 *
 * The transport is provided by the caller and not here. `Effect.provide` of a
 * layer builds it in a scope that closes with the effect it was given to, and
 * this one returns the moment the reader is forked — so providing it here would
 * take the HTTP client away from the fiber that is still reading through it.
 */
const openBoard = Effect.gen(function* () {
  const client = yield* HttpApiClient.make(Api, {
    baseUrl: origin,
    // The scheme is what selects the middleware; which credential it is does
    // not matter, because the stand-in above resolves every one of them.
    transformClient: HttpClient.mapRequest(
      HttpClientRequest.setHeader("authorization", "Bearer board-stream-test")
    ),
  });
  const snapshots = yield* client.tasks.boardStream({ query: {} });
  const inbox = yield* Queue.unbounded<readonly BoardColumn[]>();
  const reader = yield* Effect.forkChild(
    Stream.runForEach(snapshots, (columns) => Queue.offer(inbox, columns)),
    { startImmediately: true }
  );
  return { inbox, reader };
});

/** Where a card is on a board, or nothing if that board does not hold it. */
const columnOf = (
  columns: readonly BoardColumn[],
  taskId: TaskId
): TaskStatus | undefined =>
  columns.find((column) => column.tasks.some((task) => task.id === taskId))
    ?.status;

/** The run the board says is working on a card, `undefined` if it is not there. */
const runOf = (
  columns: readonly BoardColumn[],
  taskId: TaskId
): RunId | null | undefined =>
  columns.flatMap((column) => column.tasks).find((task) => task.id === taskId)
    ?.liveRunId;

/**
 * Snapshots until one says what the test is waiting for.
 *
 * Later snapshots rather than the next one, because anything else moving in
 * this workspace is also a snapshot — and because a test that asserted on
 * exactly the next one would be asserting that nothing else in the suite ever
 * shares a database.
 */
const awaitSnapshot = <A>(
  inbox: Queue.Queue<readonly BoardColumn[]>,
  reading: (columns: readonly BoardColumn[]) => A | undefined
) =>
  Effect.gen(function* () {
    const columns = yield* Queue.take(inbox);
    const found = reading(columns);
    if (found === undefined) {
      return yield* new NotSettled({ expected: 1, found: 0 });
    }
    return found;
  }).pipe(Effect.retry(Schedule.forever), Effect.timeout(WAIT_TIMEOUT));

test(
  "a card moved reaches an open board over the channel, with nothing asking",
  async () => {
    const task = await fileTask("board stream: a card that moves", "ideas");

    const seen = await Effect.runPromise(
      Effect.gen(function* () {
        const { inbox, reader } = yield* openBoard;

        // The catch-up read. Receiving it says the subscriber is running, and
        // says nothing yet about the channel.
        const first = yield* Queue.take(inbox).pipe(
          Effect.timeout(WAIT_TIMEOUT)
        );
        yield* Effect.promise(() => awaitListeners(1));

        yield* Effect.promise(() => moveTask(task, "backlog"));

        const moved = yield* awaitSnapshot(inbox, (columns) =>
          columnOf(columns, task.id) === "backlog" ? "backlog" : undefined
        );

        yield* Fiber.interrupt(reader);
        return { first: columnOf(first, task.id), moved };
      }).pipe(Effect.provide(FetchHttpClient.layer), Effect.scoped)
    );

    expect(seen.first).toBe("ideas");
    expect(seen.moved).toBe("backlog");
  },
  TEST_TIMEOUT_MS
);

test(
  "a run starting shows up on the card it is working on",
  async () => {
    const task = await fileTask(
      "board stream: a card that runs",
      "in_progress"
    );

    const seen = await Effect.runPromise(
      Effect.gen(function* () {
        const { inbox, reader } = yield* openBoard;
        const first = yield* Queue.take(inbox).pipe(
          Effect.timeout(WAIT_TIMEOUT)
        );
        yield* Effect.promise(() => awaitListeners(1));

        // Nothing about the task row changes here. The card's spinner is a fact
        // about the run table, so this is what proves the second trigger.
        const run = yield* Effect.promise(() => startRun(task.id));

        const live = yield* awaitSnapshot(inbox, (columns) => {
          const found = runOf(columns, task.id);
          return found === run.id ? found : undefined;
        });

        yield* Fiber.interrupt(reader);
        return { first: runOf(first, task.id), live };
      }).pipe(Effect.provide(FetchHttpClient.layer), Effect.scoped)
    );

    // Sitting in the column is not the same as being worked on, and the board
    // now carries the difference itself rather than making a reader ask per
    // card.
    expect(seen.first).toBeNull();
    expect(seen.live).toBeDefined();
  },
  TEST_TIMEOUT_MS
);

/**
 * Longer than Bun's ten-second default idle timeout, and shorter than the
 * ceiling `httpServerOptions` raises it to. A stream held silent across this is
 * a stream the server did not hang up on.
 */
const QUIET_MS = 12_000;

test(
  "a board nobody touches is still open after the default idle timeout",
  async () => {
    const task = await fileTask("board stream: a quiet connection", "ideas");

    const seen = await Effect.runPromise(
      Effect.gen(function* () {
        const { inbox, reader } = yield* openBoard;
        yield* Queue.take(inbox).pipe(Effect.timeout(WAIT_TIMEOUT));
        yield* Effect.promise(() => awaitListeners(1));

        // Nothing is written for longer than Bun would keep a silent
        // connection. This is the failure the whole feature had and no test
        // would have caught: a board that is being used stays up, and a board
        // nobody is touching — the one an operator leaves open all day — is
        // hung up on and stops reporting.
        yield* Effect.sleep(QUIET_MS);
        yield* Effect.promise(() => moveTask(task, "done"));

        const moved = yield* awaitSnapshot(inbox, (columns) =>
          columnOf(columns, task.id) === "done" ? "done" : undefined
        );

        yield* Fiber.interrupt(reader);
        return moved;
      }).pipe(Effect.provide(FetchHttpClient.layer), Effect.scoped)
    );

    expect(seen).toBe("done");
  },
  TEST_TIMEOUT_MS
);

test(
  "a nudge that changes nothing sends nothing, and two boards share one listener",
  async () => {
    const task = await fileTask("board stream: a quiet board", "ideas");

    const seen = await Effect.runPromise(
      Effect.gen(function* () {
        const first = yield* openBoard;
        const second = yield* openBoard;
        yield* Queue.take(first.inbox).pipe(Effect.timeout(WAIT_TIMEOUT));
        yield* Queue.take(second.inbox).pipe(Effect.timeout(WAIT_TIMEOUT));

        // Two open boards, one `LISTEN`. This is the number that decides
        // whether a wall of dashboards is a connection each or a connection
        // between them.
        const shared = yield* Effect.promise(() => awaitListeners(1));

        // A notice for a board nothing has happened to. The gateway re-reads,
        // finds what it already sent, and says nothing — so the next snapshot
        // either side receives is the real change made after it.
        yield* Effect.promise(() =>
          runStore(
            Effect.gen(function* () {
              const sql = yield* PgClient.PgClient;
              yield* sql.notify(
                BOARD_CHANNEL,
                JSON.stringify({ taskId: task.id, workspaceId })
              );
            })
          )
        );

        yield* Effect.promise(() => moveTask(task, "review"));

        const next = yield* Queue.take(first.inbox).pipe(
          Effect.timeout(WAIT_TIMEOUT)
        );

        yield* Fiber.interrupt(first.reader);
        yield* Fiber.interrupt(second.reader);
        return { next: columnOf(next, task.id), shared };
      }).pipe(Effect.provide(FetchHttpClient.layer), Effect.scoped)
    );

    expect(seen.shared).toBe(1);
    expect(seen.next).toBe("review");
  },
  TEST_TIMEOUT_MS
);
