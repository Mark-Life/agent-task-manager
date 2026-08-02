/**
 * How many runs may be in flight at once, and what happens to the one that
 * arrives when they all are.
 *
 * The cap is a property of the box rather than of the work: a trip-planning run
 * and a feature run each cost one container, one core and something like two
 * gigabytes, so there is one global count and no per-kind allowance. The number
 * itself lives in `./config`, beside the argument for it.
 *
 * **Admission is a try, never a wait.** A dispatcher that blocked on a free
 * slot would hold the task it was sweeping, and the queue would live in a fiber
 * — invisible to the board, lost on restart, and ordered by whoever asked
 * first rather than by where the cards are. So a full pool refuses immediately:
 * the task stays in *in progress* with no live run, which is a state the board
 * already renders as waiting for a slot, and the next notify or poll asks
 * again. The queue is the column, and the column is in Postgres.
 *
 * **Depth is reported at the moment the slot is taken**, because that is the
 * number the run's `atm.run` row wants: how busy the box was when this run
 * started, which is what a slow queue wait has to be read against. Counting it
 * later would measure the pool at the wrong instant, and averaging it after the
 * fact would answer a different question.
 */

import { Context, Effect, Layer, Option, Ref, Semaphore } from "effect";
import { orchestratorConfig } from "./config";

/** How full the pool is, as of one instant. */
export interface PoolStats {
  /** The global cap, from `ORCHESTRATOR_MAX_CONCURRENCY`. */
  readonly capacity: number;
  /** Slots held right now. At the moment of a claim it includes the claim itself. */
  readonly depth: number;
}

/** Slots nobody is holding. Zero means the next dispatch is refused. */
export const freeSlots = (stats: PoolStats) =>
  Math.max(0, stats.capacity - stats.depth);

/** Whether one more run could start right now. */
export const hasFreeSlot = (stats: PoolStats) => freeSlots(stats) > 0;

/** The work ran, holding a slot for as long as it took. */
export interface Admitted<A> {
  readonly kind: "admitted";
  /** Pool depth at the instant the slot was taken, this run included. */
  readonly stats: PoolStats;
  readonly value: A;
}

/** Every slot was busy, so nothing ran and nothing was written. */
export interface AtCapacity {
  readonly kind: "at_capacity";
  readonly stats: PoolStats;
}

/**
 * What asking for a slot produced. A union rather than a nullable result
 * because the refusal carries the pool it was refused by, and a dispatcher that
 * skipped a task has to be able to say which of the two reasons it was.
 */
export type Admission<A> = Admitted<A> | AtCapacity;

/** Whether this admission ran anything. */
export const wasAdmitted = <A>(
  admission: Admission<A>
): admission is Admitted<A> => admission.kind === "admitted";

/** The global cap on runs in flight, and the one way through it. */
export interface WorkerPoolInterface {
  /**
   * Runs `work` if a slot is free right now, and refuses if none is. The slot
   * is released on every exit path the work can take — a value, a typed
   * failure, a defect, and the interrupt a stop command or a SIGINT turns into
   * — because a slot leaked by a killed run is a permanently smaller box.
   */
  readonly admit: <A, E, R>(
    work: (stats: PoolStats) => Effect.Effect<A, E, R>
  ) => Effect.Effect<Admission<A>, E, R>;
  /** The cap this pool was built with. */
  readonly capacity: number;
  /** How full the pool is right now. For the sweep's log line and for a health read. */
  readonly stats: Effect.Effect<PoolStats>;
}

/** One held slot, which is all a run ever asks for. */
const ONE_SLOT = 1;

const make = Effect.gen(function* () {
  const { maxConcurrency } = yield* orchestratorConfig;
  return yield* makePool(maxConcurrency);
});

/**
 * A pool of a given size. Exported for the check scripts and the tests that
 * need a cap of one or two without an environment behind them; everything else
 * takes the configured cap through {@link WorkerPool.layer}.
 */
export const makePool = Effect.fnUntraced(function* (capacity: number) {
  const semaphore = yield* Semaphore.make(capacity);
  // The semaphore holds the permits but will not say how many are out, and the
  // depth at claim time is a field on the run's event — so it is counted here,
  // inside the permit, where the answer cannot be off by a run that is halfway
  // through acquiring one.
  const inFlight = yield* Ref.make(0);

  const stats = Ref.get(inFlight).pipe(
    Effect.map((depth): PoolStats => ({ capacity, depth }))
  );

  const admit = <A, E, R>(work: (slot: PoolStats) => Effect.Effect<A, E, R>) =>
    semaphore
      .withPermitsIfAvailable(ONE_SLOT)(
        Effect.gen(function* () {
          const depth = yield* Ref.updateAndGet(inFlight, (held) => held + 1);
          const slot: PoolStats = { capacity, depth };
          const value = yield* work(slot).pipe(
            Effect.ensuring(Ref.update(inFlight, (held) => held - 1))
          );
          return { kind: "admitted", stats: slot, value } as const;
        })
      )
      .pipe(
        Effect.flatMap(
          (taken): Effect.Effect<Admission<A>> =>
            Option.isSome(taken)
              ? Effect.succeed(taken.value)
              : stats.pipe(
                  Effect.map((current) => ({
                    kind: "at_capacity" as const,
                    stats: current,
                  }))
                )
        )
      );

  return WorkerPool.of({ admit, capacity, stats });
});

/**
 * The concurrency cap, as a service so the dispatcher and any check script hold
 * the same one. A second pool would be a second cap, and two caps on one box is
 * no cap at all.
 */
export class WorkerPool extends Context.Service<
  WorkerPool,
  WorkerPoolInterface
>()("@workspace/orchestrator/WorkerPool") {
  static readonly layer = Layer.effect(WorkerPool, make);

  /** A pool of a fixed size, for a script or a test that pins the cap. */
  static readonly layerWith = (capacity: number) =>
    Layer.effect(WorkerPool, makePool(capacity));
}
