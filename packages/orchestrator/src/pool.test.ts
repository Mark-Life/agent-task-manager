/**
 * The two things a cap has to actually do: refuse the run that would exceed it,
 * and hand the slot back when the run it was holding is killed. Everything else
 * about the pool is arithmetic.
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

const run = <A, E>(program: Effect.Effect<A, E>) => Effect.runPromise(program);

/** A pool of two — the cap the box is actually sized for — built fresh per test. */
const newPool = makePool(CAP);

describe("counting slots", () => {
  test("reports what is left, and when nothing is", () => {
    expect(freeSlots({ capacity: 2, depth: 1 })).toBe(1);
    expect(hasFreeSlot({ capacity: 2, depth: 2 })).toBe(false);
    // A resize downwards can leave more held than the cap allows; free slots
    // clamp at zero rather than going negative, because a negative would be
    // subtracted from somewhere later.
    expect(freeSlots({ capacity: 2, depth: 3 })).toBe(0);
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
            workers.admit((slot) =>
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

        const refused = yield* workers.admit(() => Effect.succeed(3));
        const full = yield* workers.stats;

        yield* release.open;
        const admitted = yield* Fiber.join(first);
        yield* Fiber.join(second);

        return { admitted, full, refused, settled: yield* workers.stats };
      })
    );

    expect(wasAdmitted(outcome.refused)).toBe(false);
    expect(outcome.refused.stats).toEqual({ capacity: CAP, depth: CAP });
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
          workers.admit(() =>
            Effect.gen(function* () {
              yield* holding.open;
              yield* never.await;
            })
          ),
          { startImmediately: true }
        );

        yield* holding.await;
        const during = yield* workers.stats;
        yield* Fiber.interrupt(fiber);

        return {
          after: yield* workers.stats,
          during,
          // The killed run's slot is free, so the next dispatch is admitted
          // rather than refused by a pool that is quietly one smaller.
          next: yield* workers.admit(() => Effect.succeed("next")),
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
          .admit(() => Effect.fail("the container died"))
          .pipe(Effect.ignore);
        return yield* workers.stats;
      })
    );

    expect(settled.depth).toBe(0);
  });
});

describe("the configured pool", () => {
  test("takes its cap from the environment, and defaults to two", async () => {
    const capacityOf = (environment: Readonly<Record<string, string>>) =>
      Effect.runPromise(
        Effect.gen(function* () {
          const workers = yield* WorkerPool;
          return workers.capacity;
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

    expect(await capacityOf({})).toBe(2);
    expect(await capacityOf({ ORCHESTRATOR_MAX_CONCURRENCY: "3" })).toBe(3);
  });
});
