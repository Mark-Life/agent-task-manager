#!/usr/bin/env bun

/**
 * Marks a card already on the board as a test fixture, so the columns stop
 * showing it and the dispatcher stops considering it.
 *
 * It exists for rows nothing can prevent any more. Before the suite had a
 * database and a workspace of its own it filed into whichever board
 * `DATABASE_URL` named, and four cards landed on the production one: `clean
 * run`, `failing run`, `truncated stream` and `loop:check — dispatched and
 * finished in a container`.
 *
 * Flagged rather than deleted, deliberately, because the rows behind these
 * cards are the only surviving record of some of the earliest runs this system
 * did. `metadata.fixture` takes a card off the board and leaves all of that
 * reachable by id.
 *
 * The reason that is not a preference: `truncated stream` had the manager's
 * first-ever comment on it — "filed here as this is the only task on the
 * board", 2026-08-03 12:58 — and by 2026-08-09 the card was gone from the
 * board, and the comment with it. Three remain. Tidying a fixture away costs
 * more than leaving it in place.
 *
 * The write merges: whatever else is in `metadata` stays, and running it twice
 * changes nothing the second time. It is audited like every other write, as
 * `system`, so the trail says a script did it and when.
 *
 *     bun run scripts/flag-fixture.ts <taskId> [<taskId> …]
 */

import { BunRuntime } from "@effect/platform-bun";
import { storeLayer, TaskRepo, WorkspaceRepo, withActor } from "@workspace/db";
import {
  Actor,
  FIXTURE_METADATA_KEY,
  isFixtureTask,
  TaskId,
  type WorkspaceId,
} from "@workspace/domain";
import { Effect, Schema } from "effect";

/** Reported as `application_name`, so `pg_stat_activity` names this process. */
const APPLICATION_NAME = "flag-fixture";

/** Not a person's decision about the work, so not a person. */
const ACTOR = Actor.cases.system.make({ reason: APPLICATION_NAME });

/** The script was told to do something it cannot. */
class BadUsage extends Schema.TaggedErrorClass<BadUsage>()(
  "FlagFixture.BadUsage",
  { detail: Schema.String }
) {}

/** The id names no card in any workspace this database holds. */
class NoSuchTask extends Schema.TaggedErrorClass<NoSuchTask>()(
  "FlagFixture.NoSuchTask",
  { taskId: TaskId }
) {}

/**
 * The workspace a card is in, found by asking each one. Every read of a task is
 * scoped to a workspace — a composite key, so that no id alone reaches a board
 * it does not belong to — and an operator holding an id off the dashboard does
 * not have the other half of it.
 */
const workspaceOf = (taskId: TaskId) =>
  Effect.gen(function* () {
    const workspaces = yield* WorkspaceRepo;
    const tasks = yield* TaskRepo;

    for (const workspace of yield* workspaces.list()) {
      const found = yield* tasks
        .byId({ id: taskId, workspaceId: workspace.id })
        .pipe(Effect.option);
      if (found._tag === "Some") {
        return { task: found.value, workspaceId: workspace.id };
      }
    }
    return yield* new NoSuchTask({ taskId });
  });

const flagOne = (taskId: TaskId) =>
  Effect.gen(function* () {
    const tasks = yield* TaskRepo;
    const { task, workspaceId } = yield* workspaceOf(taskId);

    if (isFixtureTask(task)) {
      yield* say(`${taskId}  already flagged  ${task.title}`);
      return;
    }

    yield* tasks.update({
      fields: {
        metadata: { ...task.metadata, [FIXTURE_METADATA_KEY]: true },
      },
      id: taskId,
      workspaceId: workspaceId as WorkspaceId,
    });
    yield* say(`${taskId}  flagged  ${task.title}`);
  });

const say = (line: string) =>
  Effect.sync(() => process.stdout.write(`${line}\n`));

const program = Effect.gen(function* () {
  const ids = process.argv.slice(2);
  if (ids.length === 0) {
    return yield* new BadUsage({
      detail: "name at least one task id to flag",
    });
  }

  const taskIds = yield* Effect.forEach(ids, (id) =>
    Schema.decodeUnknownEffect(TaskId)(id).pipe(
      Effect.mapError(() => new BadUsage({ detail: `${id} is not a task id` }))
    )
  );

  yield* Effect.forEach(taskIds, flagOne, { discard: true });
});

if (import.meta.main) {
  BunRuntime.runMain(
    program.pipe(
      // The tag alone reads as `FlagFixture.BadUsage:` with nothing after it,
      // and a usage error whose text is missing is worse than no check at all.
      Effect.tapError((error) =>
        Effect.logError(
          error._tag === "FlagFixture.BadUsage"
            ? error.detail
            : `could not flag: ${error._tag}`
        )
      ),
      withActor(ACTOR),
      Effect.provide(storeLayer({ applicationName: APPLICATION_NAME }))
    )
  );
}
