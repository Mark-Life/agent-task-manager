/**
 * What `metadata.fixture` does to a card, against a real database.
 *
 * The claim is narrow and the reason it is worth a test of its own is the
 * accident behind it: the suite once filed four cards onto the live board, one
 * of which then collected the manager's first-ever comment. Deleting them would
 * take the only record of those early runs with them, so they are flagged
 * instead — and a flag nobody reads is worse than no flag, because it reads as
 * handled.
 *
 * Two halves, and they have to hold together. A column listing must not show a
 * flagged card, which is also what keeps the dispatcher off it, since the board
 * and the queue are the same read. Addressing one by id must still answer, or
 * flagging would be a slower delete.
 */

import { afterAll, expect, test } from "bun:test";
import {
  Actor,
  FIXTURE_METADATA,
  type Task,
  type TaskId,
  UserId,
  type WorkspaceId,
} from "@workspace/domain";
import { Effect, ManagedRuntime } from "effect";
import { withActor } from "../actor";
import { storeLayer } from "../store";
import { ensureFixtureWorkspace } from "../testing/fixtures";
import { TaskRepo } from "./task";

/** Reported as `application_name`, so `pg_stat_activity` names this process. */
const APPLICATION_NAME = "db-task-fixture-test";

/** Filing and erasing are both a person's here: only an owner may delete. */
const person = Actor.cases.human.make({
  userId: UserId.make(APPLICATION_NAME),
});

/** The column these cards live in. Nothing dispatches out of it. */
const COLUMN = "ideas" satisfies Task["status"];

const runtime = ManagedRuntime.make(
  storeLayer({ applicationName: APPLICATION_NAME })
);

const filed: TaskId[] = [];
let workspaceId: WorkspaceId;

afterAll(async () => {
  await runtime.runPromise(
    Effect.gen(function* () {
      const tasks = yield* TaskRepo;
      yield* Effect.forEach(filed, (id) => tasks.delete({ id, workspaceId }));
    }).pipe(withActor(person))
  );
  await runtime.dispose();
});

test("a fixture card is off every column listing and still readable by id", async () => {
  const seen = await runtime.runPromise(
    Effect.gen(function* () {
      const fixture = yield* ensureFixtureWorkspace({
        suite: APPLICATION_NAME,
      });
      workspaceId = fixture.workspace.id;

      const tasks = yield* TaskRepo;
      const real = yield* tasks.create({
        status: COLUMN,
        title: "fixture test: a card somebody asked for",
        workspaceId,
      });
      const stranded = yield* tasks.create({
        metadata: FIXTURE_METADATA,
        status: COLUMN,
        title: "fixture test: a card the suite left behind",
        workspaceId,
      });
      filed.push(real.id, stranded.id);

      return {
        board: yield* tasks.board({ id: stranded.id, workspaceId }),
        column: yield* tasks.byStatus({ status: COLUMN, workspaceId }),
        direct: yield* tasks.byId({ id: stranded.id, workspaceId }),
        real,
        stranded,
      };
    }).pipe(withActor(person))
  );

  const listed = seen.column.map((task) => task.id);
  expect(listed).toContain(seen.real.id);
  expect(listed).not.toContain(seen.stranded.id);

  // Flagged, not erased: the card, its thread and everything hanging off it are
  // still there for anyone holding a link to them.
  expect(seen.direct.id).toBe(seen.stranded.id);
  expect(seen.board.task.id).toBe(seen.stranded.id);
  expect(seen.direct.metadata.fixture).toBe(true);
});
