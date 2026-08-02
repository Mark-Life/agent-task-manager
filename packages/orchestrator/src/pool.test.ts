/**
 * The three things a cap has to actually do: refuse the run that would exceed
 * it, hand the slot back when the run it was holding is killed, and keep a chat
 * turn out of the queue a long worker run is holding. Everything else about the
 * pool is arithmetic.
 *
 * Concurrency here is held open with latches rather than sleeps, so a slot that
 * leaks fails the test instead of passing it slowly.
 */

import { describe, expect, test } from "bun:test";
import { ConfigProvider, Effect, Fiber, Latch, Layer } from "effect";
import {
  freeSlots,
  hasFreeSlot,
  makePool,
  WorkerPool,
  wasAdmitted,
} from "./pool";

const CAP = 2;
const CHAT_CAP = 1;

const run = <A, E>(program: Effect.Effect<A, E>) => Effect.runPromise(program);

/** The caps the box is actually sized for — two and one — built fresh per test. */
const newPool = makePool({ chat: CHAT_CAP, work: CAP });

/** A lane's stats, spelled once so a test reads as the arithmetic it is. */
const stats = (input: { capacity: number; depth: number }) => ({
  ...input,
  lane: "work" as const,
  totalDepth: input.depth,
});

describe("counting slots", () => {
  test("reports what is left, and when nothing is", () => {
    expect(freeSlots(stats({ capacity: 2, depth: 1 }))).toBe(1);
    expect(hasFreeSlot(stats({ capacity: 2, depth: 2 }))).toBe(false);
    // A resize downwards can leave more held than the cap allows; free slots
    // clamp at zero rather than going negative, because a negative would be
    // subtracted from somewhere later.
    expect(freeSlots(stats({ capacity: 2, depth: 3 }))).toBe(0);
  });
});

describe("the cap", () => {
  test("admits up to the cap and refuses the next one", async () => {
    const outcome = await run(
      Effect.gen(function* () {
        const workers = yield* newPool;
        const holding = yield* Latch.make(false);
        const release = yield* Latch.make(false);

        const hold = (index: number) =>
          Effect.forkChild(
            workers.admit("work", (slot) =>
              Effect.gen(function* () {
                if (slot.depth === CAP) {
                  yield* holding.open;
                }
                yield* release.await;
                return index;
              })
            ),
            { startImmediately: true }
          );

        const first = yield* hold(1);
        const second = yield* hold(2);
        yield* holding.await;

        const refused = yield* workers.admit("work", () => Effect.succeed(3));
        const full = yield* workers.statsOf("work");

        yield* release.open;
        const admitted = yield* Fiber.join(first);
        yield* Fiber.join(second);

        return {
          admitted,
          full,
          refused,
          settled: yield* workers.statsOf("work"),
        };
      })
    );

    expect(wasAdmitted(outcome.refused)).toBe(false);
    expect(outcome.refused.stats).toEqual({
      capacity: CAP,
      depth: CAP,
      lane: "work",
      totalDepth: CAP,
    });
    expect(outcome.full.depth).toBe(CAP);
    // The run that did get a slot reports the depth as of the moment it took
    // one — itself included — which is what its `atm.run` row carries.
    expect(wasAdmitted(outcome.admitted)).toBe(true);
    expect(outcome.settled.depth).toBe(0);
  });

  test("gives the slot back when the run is interrupted", async () => {
    const outcome = await run(
      Effect.gen(function* () {
        const workers = yield* newPool;
        const holding = yield* Latch.make(false);
        const never = yield* Latch.make(false);

        const fiber = yield* Effect.forkChild(
          workers.admit("work", () =>
            Effect.gen(function* () {
              yield* holding.open;
              yield* never.await;
            })
          ),
          { startImmediately: true }
        );

        yield* holding.await;
        const during = yield* workers.statsOf("work");
        yield* Fiber.interrupt(fiber);

        return {
          after: yield* workers.statsOf("work"),
          during,
          // The killed run's slot is free, so the next dispatch is admitted
          // rather than refused by a pool that is quietly one smaller.
          next: yield* workers.admit("work", () => Effect.succeed("next")),
        };
      })
    );

    expect(outcome.during.depth).toBe(1);
    expect(outcome.after.depth).toBe(0);
    expect(wasAdmitted(outcome.next)).toBe(true);
  });

  test("gives the slot back when the run fails", async () => {
    const settled = await run(
      Effect.gen(function* () {
        const workers = yield* newPool;
        yield* workers
          .admit("work", () => Effect.fail("the container died"))
          .pipe(Effect.ignore);
        return yield* workers.statsOf("work");
      })
    );

    expect(settled.depth).toBe(0);
  });
});

describe("the second lane", () => {
  test("keeps a chat turn out of the queue a full work lane is holding", async () => {
    const outcome = await run(
      Effect.gen(function* () {
        const workers = yield* newPool;
        const holding = yield* Latch.make(false);
        const release = yield* Latch.make(false);

        const hold = () =>
          Effect.forkChild(
            workers.admit("work", (slot) =>
              Effect.gen(function* () {
                if (slot.depth === CAP) {
                  yield* holding.open;
                }
                yield* release.await;
                return slot;
              })
            ),
            { startImmediately: true }
          );

        const first = yield* hold();
        const second = yield* hold();
        yield* holding.await;

        // This is the whole reason the lane exists: two hour-long worker runs
        // are holding every work slot, and the person waiting on an answer is
        // admitted anyway.
        const chat = yield* workers.admit("chat", (slot) =>
          Effect.succeed(slot)
        );
        const refusedWork = yield* workers.admit("work", () =>
          Effect.succeed("no")
        );

        yield* release.open;
        yield* Fiber.join(first);
        yield* Fiber.join(second);
        return { chat, refusedWork };
      })
    );

    expect(wasAdmitted(outcome.chat)).toBe(true);
    expect(wasAdmitted(outcome.refusedWork)).toBe(false);
    // The box's cap is the sum, and the chat run can see it: three containers
    // were in flight at the instant it took its slot.
    expect(wasAdmitted(outcome.chat) && outcome.chat.value.totalDepth).toBe(
      CAP + CHAT_CAP
    );
    expect(wasAdmitted(outcome.chat) && outcome.chat.value.lane).toBe("chat");
  });
});

describe("the configured pool", () => {
  test("takes both caps from the environment, and defaults to two and one", async () => {
    const capacitiesOf = (environment: Readonly<Record<string, string>>) =>
      Effect.runPromise(
        Effect.gen(function* () {
          const workers = yield* WorkerPool;
          return {
            chat: workers.capacityOf("chat"),
            work: workers.capacityOf("work"),
          };
        }).pipe(
          Effect.provide(
            WorkerPool.layer.pipe(
              Layer.provide(
                ConfigProvider.layer(ConfigProvider.fromUnknown(environment))
              )
            )
          )
        )
      );

    expect(await capacitiesOf({})).toEqual({ chat: 1, work: 2 });
    expect(
      await capacitiesOf({
        ORCHESTRATOR_MAX_CHAT_CONCURRENCY: "2",
        ORCHESTRATOR_MAX_CONCURRENCY: "3",
      })
    ).toEqual({ chat: 2, work: 3 });
  });
});
