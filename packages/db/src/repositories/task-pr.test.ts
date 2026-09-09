/**
 * What the cached pull request state does to a task row, against a real
 * database.
 *
 * Three claims, and each one is a bug that would be invisible from the outside.
 *
 * A state that is already stored must not be written again: the refresh runs
 * every couple of minutes for every pull request somebody is looking at, and
 * every write to `task` carries an audit row, so a repeat write turns the audit
 * log into a polling log.
 *
 * A state must not land on a card whose `pr_url` has moved. The lookup is a
 * network round trip and a person can retarget the field while one is in
 * flight; the wrong answer would then sit on the card until the pull request it
 * describes was merged, which is a state the refresh stops at.
 *
 * Retargeting the field must clear what was cached for the old one, for the
 * same reason from the other side: a card moved from a merged request to a new
 * one would otherwise keep drawing the purple icon and never be asked about
 * again.
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
const APPLICATION_NAME = "db-task-pr-test";

/** Filing and erasing are both a person's here: only an owner may delete. */
const person = Actor.cases.human.make({
  userId: UserId.make(APPLICATION_NAME),
});

/** The column these cards live in. Nothing dispatches out of it. */
const COLUMN = "ideas" satisfies Task["status"];

const FIRST_PR = "https://github.com/acme/widgets/pull/7";
const SECOND_PR = "https://github.com/acme/widgets/pull/8";

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

/** A card carrying a pull request, flagged so no column listing shows it. */
const fileCard = Effect.fn(function* (prUrl: string) {
  const fixture = yield* ensureFixtureWorkspace({ suite: APPLICATION_NAME });
  workspaceId = fixture.workspace.id;

  const tasks = yield* TaskRepo;
  const card = yield* tasks.create({
    metadata: FIXTURE_METADATA,
    prUrl,
    status: COLUMN,
    title: "pr state test: a card with a pull request",
    workspaceId,
  });
  filed.push(card.id);
  return card;
});

test("records a new state once and does not write it a second time", async () => {
  const seen = await runtime.runPromise(
    Effect.gen(function* () {
      const card = yield* fileCard(FIRST_PR);
      const tasks = yield* TaskRepo;

      const first = yield* tasks.recordPrState({
        etag: 'W/"one"',
        id: card.id,
        prUrl: FIRST_PR,
        state: "open",
        workspaceId,
      });
      const stored = yield* tasks.prCache({ id: card.id, workspaceId });
      // The same answer again, which is what every refresh of an unchanged
      // pull request produces.
      const repeat = yield* tasks.recordPrState({
        etag: 'W/"two"',
        id: card.id,
        prUrl: FIRST_PR,
        state: "open",
        workspaceId,
      });
      const merged = yield* tasks.recordPrState({
        etag: 'W/"three"',
        id: card.id,
        prUrl: FIRST_PR,
        state: "merged",
        workspaceId,
      });

      return {
        after: yield* tasks.prCache({ id: card.id, workspaceId }),
        card: yield* tasks.byId({ id: card.id, workspaceId }),
        first,
        merged,
        repeat,
        stored,
      };
    }).pipe(withActor(person))
  );

  expect(seen.first).toBe(true);
  expect(seen.stored?.prState).toBe("open");
  expect(seen.stored?.prEtag).toBe('W/"one"');
  expect(seen.stored?.prStateAt).not.toBeNull();

  // The claim the audit log rests on: the second identical answer is not a
  // write, so it leaves no row behind it.
  expect(seen.repeat).toBe(false);
  expect(seen.merged).toBe(true);
  expect(seen.after?.prState).toBe("merged");
  expect(seen.after?.prEtag).toBe('W/"three"');
  // And the state reaches the entity, which is what the board draws from.
  expect(seen.card.prState).toBe("merged");
});

test("refuses a state fetched for a pull request the card has left", async () => {
  const seen = await runtime.runPromise(
    Effect.gen(function* () {
      const card = yield* fileCard(FIRST_PR);
      const tasks = yield* TaskRepo;

      // The lookup was for the first pull request; the field moved on while it
      // was in flight.
      yield* tasks.update({
        fields: { prUrl: SECOND_PR },
        id: card.id,
        workspaceId,
      });
      const landed = yield* tasks.recordPrState({
        etag: 'W/"stale"',
        id: card.id,
        prUrl: FIRST_PR,
        state: "merged",
        workspaceId,
      });

      return {
        cache: yield* tasks.prCache({ id: card.id, workspaceId }),
        landed,
      };
    }).pipe(withActor(person))
  );

  expect(seen.landed).toBe(false);
  expect(seen.cache?.prUrl).toBe(SECOND_PR);
  expect(seen.cache?.prState).toBeNull();
});

test("clears the cached state when the card is pointed at another pull request", async () => {
  const seen = await runtime.runPromise(
    Effect.gen(function* () {
      const card = yield* fileCard(FIRST_PR);
      const tasks = yield* TaskRepo;

      yield* tasks.recordPrState({
        etag: 'W/"one"',
        id: card.id,
        prUrl: FIRST_PR,
        state: "merged",
        workspaceId,
      });
      const before = yield* tasks.prCache({ id: card.id, workspaceId });

      yield* tasks.update({
        fields: { prUrl: SECOND_PR },
        id: card.id,
        workspaceId,
      });
      const after = yield* tasks.prCache({ id: card.id, workspaceId });

      // A patch that says nothing about the pull request leaves the cache
      // alone, or every edit to a card's brief would cost a lookup.
      yield* tasks.recordPrState({
        etag: 'W/"two"',
        id: card.id,
        prUrl: SECOND_PR,
        state: "open",
        workspaceId,
      });
      yield* tasks.update({
        fields: { title: "pr state test: renamed" },
        id: card.id,
        workspaceId,
      });

      return {
        after,
        before,
        renamed: yield* tasks.prCache({ id: card.id, workspaceId }),
      };
    }).pipe(withActor(person))
  );

  expect(seen.before?.prState).toBe("merged");
  expect(seen.after?.prState).toBeNull();
  expect(seen.after?.prStateAt).toBeNull();
  expect(seen.after?.prEtag).toBeNull();
  expect(seen.renamed?.prState).toBe("open");
});
