/**
 * The board's write surface, through the HTTP layer and against a real
 * database.
 *
 * Projects, tasks and comments are tested together because they are one
 * surface: filing a task, moving it, ordering it and saying something on it are
 * the operations the dashboard drags and the manager agent calls, and the whole
 * design is that those are the same write. Testing them through the router
 * rather than against the repositories is the point — the parts that can be
 * wrong here are the parts a repository test cannot see: whether the workspace
 * really comes off the credential, whether a refused move reaches the caller as
 * 409 rather than as a 500, whether the audit row names the person who called
 * instead of the process that served them.
 *
 * Nothing is mocked. The one stand-in is the access middleware, which resolves
 * every credential to one fixed principal, because credential resolution is not
 * this file's claim and refusing everything — which is what the gateway does
 * today — would leave nothing to test.
 *
 * The workspace is the auth library's `organization` row; `bun run db:seed`
 * owns it. Everything these tests create is erased afterwards. The audit rows
 * stay, as they do everywhere: the trail is append-only, which is the whole
 * claim it makes.
 */

import { afterAll, describe, expect, test } from "bun:test";
import { BunHttpServer, BunServices } from "@effect/platform-bun";
import {
  AdminAccess,
  Api,
  BoardColumn,
  Comment,
  Principal,
  type PrincipalShape,
  Project,
  ReadAccess,
  Task,
  TaskDetail,
  TaskWriteAccess,
} from "@workspace/api";
import {
  AuditLogRepo,
  CurrentActor,
  ProjectRepo,
  storeLayer,
  TaskRepo,
  WorkspaceRepo,
  withActor,
} from "@workspace/db";
import {
  Actor,
  newProjectId,
  newTaskId,
  type ProjectId,
  TASK_STATUSES,
  type TaskId,
  UserId,
} from "@workspace/domain";
import { Effect, Layer, ManagedRuntime, Schema } from "effect";
import { HttpRouter } from "effect/unstable/http";
import { HttpApiBuilder } from "effect/unstable/httpapi";
import { RunEventNotices } from "../sse";
import { handlersLayer } from "./index";

/** Reported as `application_name`, so `pg_stat_activity` names this process. */
const APPLICATION_NAME = "gateway-board-test";

/** The host in the URLs below. Never resolved: the handler is called directly. */
const ORIGIN = "http://gateway.test";

/** The person every request in this file is made by. */
const human = Actor.cases.human.make({
  userId: UserId.make("gateway-board-test-human"),
});

/** The database has never been seeded, so there is no workspace to file into. */
class NoWorkspace extends Schema.TaggedErrorClass<NoWorkspace>()(
  "BoardTest.NoWorkspace",
  { detail: Schema.String }
) {}

const runtime = ManagedRuntime.make(
  storeLayer({ applicationName: APPLICATION_NAME })
);

const workspaceId = await runtime.runPromise(
  Effect.gen(function* () {
    const workspaces = yield* WorkspaceRepo;
    const [first] = yield* workspaces.list();
    if (first === undefined) {
      return yield* Effect.fail(
        new NoWorkspace({ detail: "run `bun run db:seed` first" })
      );
    }
    return first.id;
  })
);

/** Who every request below resolves to, at the widest scope. */
const principal: PrincipalShape = {
  actor: human,
  scope: "admin",
  workspaceId,
};

/** Grants one request, whichever scheme its credential arrived under. */
const grant = <A, E, R>(httpEffect: Effect.Effect<A, E, R>) =>
  Effect.provideService(httpEffect, Principal, principal);

/**
 * The access middleware, standing in for credential resolution. It says yes to
 * everything, which is exactly what makes the rest of this file about handlers.
 */
const accessLayer = Layer.mergeAll(
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

const storeForHandlers = storeLayer({ applicationName: APPLICATION_NAME });

/**
 * Everything a group is built over: the repositories, the notice multicast the
 * run group holds even where nothing streams, and Bun's platform services.
 *
 * One `Layer.provide` is enough because every group takes its repositories
 * while its layer is being built — see `./at-build` for why a handler must not
 * ask for one per request.
 */
const services = Layer.mergeAll(
  storeForHandlers,
  BunServices.layer,
  RunEventNotices.layer.pipe(Layer.provide(storeForHandlers))
);

/**
 * The whole contract as a fetch handler.
 *
 * The router is the real one, so a request here goes through the same decoding,
 * middleware and error rendering a request arriving over a socket would.
 */
const { dispose, handler } = HttpRouter.toWebHandler(
  HttpApiBuilder.layer(Api).pipe(
    Layer.provide(handlersLayer),
    Layer.provide(
      Layer.mergeAll(accessLayer, CurrentActor.layer(human), services)
    ),
    Layer.provide(BunHttpServer.layerHttpServices)
  )
);

/** One request, with a credential the stand-in above accepts. */
const call = (method: string, path: string, body?: unknown) =>
  handler(
    new Request(`${ORIGIN}${path}`, {
      body: body === undefined ? undefined : JSON.stringify(body),
      headers: {
        authorization: "Bearer board-test",
        "content-type": "application/json",
      },
      method,
    })
  );

/**
 * The body, decoded through the schema the contract publishes — as JSON, since
 * an instant is a `Date` in the entity and an ISO string on the wire. A
 * response that does not decode fails the test where it was read, which is the
 * point: the shape a caller receives is supposed to be the entity.
 */
const decoded = <S extends Schema.Codec<unknown, unknown, never, never>>(
  schema: S,
  raw: unknown
) =>
  Effect.runPromise(
    Schema.decodeUnknownEffect(Schema.toCodecJson(schema))(raw)
  );

const bodyOf = async <S extends Schema.Codec<unknown, unknown, never, never>>(
  response: Response,
  schema: S
) => await decoded(schema, await response.json());

/** What every failure in this contract answers with, as far as a test cares. */
interface WireFailure {
  readonly _tag: string;
  readonly from?: string;
  readonly to?: string;
}

const failureOf = async (response: Response) =>
  (await response.json()) as WireFailure;

/** Everything these tests filed, so the same lists can erase them at the end. */
const filedTasks: TaskId[] = [];
const filedProjects: ProjectId[] = [];

/**
 * Files a project through the API and remembers it for cleanup.
 *
 * The id is taken off the raw body before anything is decoded: a row this file
 * created has to be erased even when the response it came back in turns out to
 * be wrong, which is precisely when a test fails.
 */
const fileProject = async (name: string) => {
  const raw = (await (await call("POST", "/projects", { name })).json()) as {
    readonly id?: ProjectId;
  };
  if (raw.id !== undefined) {
    filedProjects.push(raw.id);
  }
  return await decoded(Project, raw);
};

/** Files a task through the API and remembers it for cleanup, the same way. */
const fileTask = async (input: {
  readonly projectId?: ProjectId;
  readonly title: string;
}) => {
  const raw = (await (await call("POST", "/tasks", input)).json()) as {
    readonly id?: TaskId;
  };
  if (raw.id !== undefined) {
    filedTasks.push(raw.id);
  }
  return await decoded(Task, raw);
};

/** The audit trail of one task, newest first. */
const auditOf = (taskId: TaskId) =>
  runtime.runPromise(
    Effect.gen(function* () {
      const log = yield* AuditLogRepo;
      return yield* log.forTask({ taskId, workspaceId });
    })
  );

afterAll(async () => {
  await runtime.runPromise(
    Effect.gen(function* () {
      const tasks = yield* TaskRepo;
      const projects = yield* ProjectRepo;
      yield* Effect.forEach(filedTasks, (id) =>
        Effect.ignore(tasks.delete({ id, workspaceId }))
      );
      yield* Effect.forEach(filedProjects, (id) =>
        Effect.ignore(projects.delete({ id, workspaceId }))
      );
    }).pipe(withActor(human))
  );
  await dispose();
  await runtime.dispose();
});

describe("projects", () => {
  test("files a project, reads it back and edits it", async () => {
    const filed = await fileProject("board test project");
    expect(filed.workspaceId).toBe(workspaceId);
    expect(filed.repoUrl).toBeNull();

    const read = await call("GET", `/projects/${filed.id}`);
    expect(read.status).toBe(200);
    expect((await bodyOf(read, Project)).name).toBe("board test project");

    const patched = await call("PATCH", `/projects/${filed.id}`, {
      description: "renamed",
      name: "board test project, renamed",
    });
    expect(patched.status).toBe(200);
    expect((await bodyOf(patched, Project)).description).toBe("renamed");

    const listed = await bodyOf(
      await call("GET", "/projects"),
      Schema.Array(Project)
    );
    expect(listed.map((project) => project.id)).toContain(filed.id);
  });

  test("answers 404 for a project this workspace does not have", async () => {
    const response = await call("GET", `/projects/${newProjectId()}`);
    expect(response.status).toBe(404);
    expect((await failureOf(response))._tag).toBe("NotFound");
  });

  test("answers 422 for a patch that would change nothing", async () => {
    const filed = await fileProject("board test empty patch");
    const response = await call("PATCH", `/projects/${filed.id}`, {});
    expect(response.status).toBe(422);
    expect((await failureOf(response))._tag).toBe("InvalidInput");
  });
});

describe("tasks", () => {
  test("files a task, edits it and moves it where the machine allows", async () => {
    const project = await fileProject("board test lifecycle");
    const filed = await fileTask({
      projectId: project.id,
      title: "board test lifecycle",
    });
    expect(filed.status).toBe("ideas");
    expect(filed.workspaceId).toBe(workspaceId);

    const patched = await call("PATCH", `/tasks/${filed.id}`, {
      brief: "what the run should do",
    });
    expect(patched.status).toBe(200);
    expect((await bodyOf(patched, Task)).brief).toBe("what the run should do");

    const moved = await call("POST", `/tasks/${filed.id}/status`, {
      to: "backlog",
    });
    expect(moved.status).toBe(200);
    expect((await bodyOf(moved, Task)).status).toBe("backlog");

    // Moving a card into `in_progress` is the trigger — one write, no second
    // confirmation, and the orchestrator picks the row up off it.
    const started = await call("POST", `/tasks/${filed.id}/status`, {
      to: "in_progress",
    });
    expect((await bodyOf(started, Task)).status).toBe("in_progress");

    const detail = await bodyOf(
      await call("GET", `/tasks/${filed.id}`),
      TaskDetail
    );
    expect(detail.project?.id).toBe(project.id);
    expect(detail.liveRunId).toBeNull();
  });

  test("refuses a move the status machine does not have", async () => {
    const filed = await fileTask({ title: "board test illegal move" });

    const response = await call("POST", `/tasks/${filed.id}/status`, {
      to: "done",
    });
    expect(response.status).toBe(409);

    const failure = await failureOf(response);
    expect(failure._tag).toBe("IllegalTransition");
    expect(failure.from).toBe("ideas");
    expect(failure.to).toBe("done");
  });

  test("answers 404 for a task this workspace does not have", async () => {
    const response = await call("GET", `/tasks/${newTaskId()}`);
    expect(response.status).toBe(404);
    expect((await failureOf(response))._tag).toBe("NotFound");
  });

  test("ranks a card between its two neighbours", async () => {
    const project = await fileProject("board test ranking");
    const first = await fileTask({ projectId: project.id, title: "first" });
    const second = await fileTask({ projectId: project.id, title: "second" });
    const third = await fileTask({ projectId: project.id, title: "third" });
    expect(first.rank).toBeLessThan(second.rank);
    expect(second.rank).toBeLessThan(third.rank);

    const placed = await bodyOf(
      await call("POST", `/tasks/${third.id}/place`, { after: first.rank }),
      Task
    );
    expect(placed.rank).toBeGreaterThan(first.rank);
    expect(placed.rank).toBeLessThan(second.rank);

    const column = await bodyOf(
      await call("GET", `/tasks?status=ideas&projectId=${project.id}`),
      Schema.Array(Task)
    );
    expect(column.map((task) => task.title)).toEqual([
      "first",
      "third",
      "second",
    ]);
  });

  test("answers the whole board, column by column", async () => {
    const project = await fileProject("board test columns");
    const idea = await fileTask({ projectId: project.id, title: "an idea" });
    await call("POST", `/tasks/${idea.id}/status`, { to: "backlog" });
    await fileTask({ projectId: project.id, title: "another idea" });

    const board = await bodyOf(
      await call("GET", `/tasks/board?projectId=${project.id}`),
      Schema.Array(BoardColumn)
    );
    expect(board.map((column) => column.status)).toEqual([...TASK_STATUSES]);

    const titles = Object.fromEntries(
      board.map((column) => [
        column.status,
        column.tasks.map((task) => task.title),
      ])
    );
    expect(titles.ideas).toEqual(["another idea"]);
    expect(titles.backlog).toEqual(["an idea"]);
    expect(titles.done).toEqual([]);
  });

  test("pins the session the next run uses, and puts it back", async () => {
    const filed = await fileTask({ title: "board test next session" });

    const fresh = await bodyOf(
      await call("PUT", `/tasks/${filed.id}/next-session`, { mode: "new" }),
      Task
    );
    expect(fresh.nextSessionNew).toBe(true);
    expect(fresh.nextSessionId).toBeNull();

    const latest = await bodyOf(
      await call("PUT", `/tasks/${filed.id}/next-session`, { mode: "latest" }),
      Task
    );
    expect(latest.nextSessionNew).toBe(false);
  });

  test("erases a task, and it is gone", async () => {
    const filed = await fileTask({ title: "board test erasure" });

    const erased = await call("DELETE", `/tasks/${filed.id}`);
    expect(erased.status).toBe(204);

    const read = await call("GET", `/tasks/${filed.id}`);
    expect(read.status).toBe(404);
  });
});

describe("comments", () => {
  test("signs a comment with the credential, not with the body", async () => {
    const filed = await fileTask({ title: "board test thread" });

    const posted = await bodyOf(
      await call("POST", `/tasks/${filed.id}/comments`, {
        authorKind: "agent",
        authorUserId: "somebody-else",
        body: "the first thing said",
      }),
      Comment
    );
    expect(posted.authorKind).toBe("human");
    expect(posted.authorUserId).toBe(human.userId);
    expect(posted.agentSessionId).toBeNull();
    expect(posted.kind).toBe("message");

    await call("POST", `/tasks/${filed.id}/comments`, {
      body: "the second thing said",
    });

    const thread = await bodyOf(
      await call("GET", `/tasks/${filed.id}/comments`),
      Schema.Array(Comment)
    );
    expect(thread.map((comment) => comment.body)).toEqual([
      "the first thing said",
      "the second thing said",
    ]);
  });

  test("answers 404 on a thread whose task is not there", async () => {
    const missing = newTaskId();

    const read = await call("GET", `/tasks/${missing}/comments`);
    expect(read.status).toBe(404);

    const posted = await call("POST", `/tasks/${missing}/comments`, {
      body: "into the void",
    });
    expect(posted.status).toBe(404);
    expect((await failureOf(posted))._tag).toBe("NotFound");
  });
});

describe("the audit trail", () => {
  test("names the caller on every mutation, not the process", async () => {
    const filed = await fileTask({ title: "board test attribution" });
    await call("PATCH", `/tasks/${filed.id}`, { brief: "edited" });
    await call("POST", `/tasks/${filed.id}/status`, { to: "backlog" });
    await call("POST", `/tasks/${filed.id}/comments`, { body: "said" });

    const entries = await auditOf(filed.id);

    expect(entries.length).toBeGreaterThanOrEqual(4);
    for (const entry of entries) {
      expect(entry.actorKind).toBe("human");
      expect(entry.actorUserId).toBe(human.userId);
    }

    const transition = entries.find((entry) => entry.action === "transition");
    expect(transition?.fromStatus).toBe("ideas");
    expect(transition?.toStatus).toBe("backlog");

    const update = entries.find((entry) => entry.action === "update");
    expect(update?.changes.brief?.to).toBe("edited");

    expect(
      entries.filter((entry) => entry.entityType === "comment")
    ).toHaveLength(1);
  });
});
