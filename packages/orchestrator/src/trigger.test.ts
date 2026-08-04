/**
 * The trigger, against a real database and against the migration that installs
 * it.
 *
 * Two things can be wrong here and neither shows up in a type: a channel name
 * can drift from the one the migration publishes on, and the trigger's `WHEN`
 * clause can stop matching what dispatch means. Both fail silently — a loop
 * that listens forever and never wakes looks exactly like a board with nothing
 * on it — so both are asserted, one by reading the migration and one by moving
 * a real card and waiting to hear about it.
 *
 * The move is repeated rather than made once. `LISTEN` takes effect when its
 * statement returns, and nothing observable says when that was; repeating the
 * entry into the column until the listener answers is what removes the race
 * without a fixed sleep standing in for a synchronization primitive that does
 * not exist.
 */

import { afterAll, expect, test } from "bun:test";
import { join } from "node:path";
import { PgClient } from "@effect/sql-pg";
import { storeLayer, TaskRepo, WorkspaceRepo, withActor } from "@workspace/db";
import { Actor, type TaskId, UserId } from "@workspace/domain";
import { file, Glob } from "bun";
import {
  Effect,
  Fiber,
  ManagedRuntime,
  Option,
  Schedule,
  Schema,
  Stream,
} from "effect";
import {
  CHAT_CHANNEL,
  COMMAND_CHANNEL,
  commandSignals,
  DISPATCH_CHANNEL,
  type DispatchSignal,
  notifySignals,
} from "./trigger";

/** Reported as `application_name`, so `pg_stat_activity` names this process. */
const APPLICATION_NAME = "orchestrator-trigger-test";

/** How often the card is moved back into the column while waiting to be heard. */
const NUDGE_INTERVAL_MS = 100;

/** Long enough for a local database, short enough to fail rather than hang. */
const HEARD_TIMEOUT = "10 seconds";

/** Where the migrations live, relative to this package. */
const MIGRATIONS_DIR = join(import.meta.dir, "../../db/drizzle");

/** The database has never been seeded, so there is no workspace to hang a task on. */
class NoWorkspace extends Schema.TaggedErrorClass<NoWorkspace>()(
  "TriggerTest.NoWorkspace",
  { detail: Schema.String }
) {}

const runtime = ManagedRuntime.make(
  storeLayer({ applicationName: APPLICATION_NAME })
);

const human = Actor.cases.human.make({
  userId: UserId.make("trigger-test-human"),
});

const asHuman = withActor(human);

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

const filed: TaskId[] = [];

afterAll(async () => {
  await runtime.runPromise(
    Effect.gen(function* () {
      const tasks = yield* TaskRepo;
      yield* Effect.forEach(filed, (id) =>
        asHuman(tasks.delete({ id, workspaceId }))
      );
    })
  );
  await runtime.dispose();
});

test("every channel this loop listens on is one the migrations publish on", async () => {
  const migrations = new Glob("*/migration.sql").scan({ cwd: MIGRATIONS_DIR });

  const bodies: string[] = [];
  for await (const path of migrations) {
    bodies.push(await file(join(MIGRATIONS_DIR, path)).text());
  }

  const sql = bodies.join("\n");
  // A channel spelled one way here and another way in a migration is a loop
  // that listens forever and never wakes, which is why the constants are
  // asserted against the SQL rather than against each other.
  for (const channel of [DISPATCH_CHANNEL, COMMAND_CHANNEL, CHAT_CHANNEL]) {
    expect(sql).toContain(`pg_notify('${channel}'`);
  }
});

test("a card entering the column reaches the listener", async () => {
  const signal = await runtime.runPromise(
    Effect.gen(function* () {
      const tasks = yield* TaskRepo;
      const task = yield* asHuman(
        tasks.create({
          status: "backlog",
          title: "trigger: notifies on entering the column",
          workspaceId,
        })
      );
      filed.push(task.id);

      const heard = yield* Effect.forkChild(
        Stream.runHead(
          Stream.filter(
            notifySignals,
            (candidate) => candidate.notice?.taskId === task.id
          )
        ),
        { startImmediately: true }
      );

      // Out and back in: only entering the column fires the trigger, so the
      // card has to leave it to be able to enter it again.
      const nudge = Effect.gen(function* () {
        yield* asHuman(
          tasks.transition({ id: task.id, to: "in_progress", workspaceId })
        );
        yield* asHuman(
          tasks.transition({ id: task.id, to: "backlog", workspaceId })
        );
      });

      const found = yield* Effect.race(
        Fiber.join(heard),
        Effect.as(
          Effect.repeat(nudge, Schedule.spaced(NUDGE_INTERVAL_MS)),
          Option.none<DispatchSignal>()
        )
      ).pipe(Effect.timeout(HEARD_TIMEOUT));

      return Option.getOrNull(found);
    })
  );

  expect(signal?.source).toBe("notify");
  expect(signal?.notice?.workspaceId).toBe(workspaceId);
  expect(typeof signal?.notice?.rank).toBe("number");
});

test("a published command reaches the listener", async () => {
  const signal = await runtime.runPromise(
    Effect.gen(function* () {
      const sql = yield* PgClient.PgClient;
      const heard = yield* Effect.forkChild(Stream.runHead(commandSignals), {
        startImmediately: true,
      });

      // Published directly rather than by writing a command row: what is under
      // test is that this process is listening on the channel the queue's
      // trigger publishes on, and the row it would need has a task, an actor
      // and a live run behind it — three things unrelated to that question.
      const nudge = sql`select pg_notify(${COMMAND_CHANNEL}, '{}')`;

      const found = yield* Effect.race(
        Fiber.join(heard),
        Effect.as(
          Effect.repeat(nudge, Schedule.spaced(NUDGE_INTERVAL_MS)),
          Option.none<DispatchSignal>()
        )
      ).pipe(Effect.timeout(HEARD_TIMEOUT));

      return Option.getOrNull(found);
    })
  );

  expect(signal?.source).toBe("command");
  expect(signal?.notice).toBeNull();
});
