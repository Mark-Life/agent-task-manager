/**
 * How many runs may be in flight at once, and what happens to the one that
 * arrives when they all are.
 *
 * The cap is a property of the box rather than of the work: a trip-planning run
 * and a feature run each cost one container, one core and something like two
 * gigabytes. The numbers themselves live in `./config`, beside the argument for
 * them.
 *
 * **Two lanes, one pool.** Board work and chat each get their own count, and
 * the box's cap is the sum. Two semaphores rather than one with a reservation,
 * because the failure the lane exists to prevent is a person waiting on an
 * answer behind two day-long worker runs — and a reservation only guarantees
 * that when the reserved count is a separate count anyway. It stays one
 * service for the opposite reason: two services would be two caps, and two caps
 * on one box is no cap at all.
 *
 * **Admission is a try, never a wait.** A dispatcher that blocked on a free
 * slot would hold the work it was sweeping, and the queue would live in a fiber
 * — invisible to the board, lost on restart, and ordered by whoever asked
 * first rather than by where the cards are. So a full lane refuses immediately:
 * the task stays in *in progress* with no live run and the message stays unread
 * in its thread, which are states the queue reads back as waiting, and the next
 * notify or poll asks again. The queue is in Postgres.
 *
 * **Depth is reported at the moment the slot is taken**, because that is the
 * number the run's `atm.run` row wants: how busy the box was when this run
 * started, which is what a slow queue wait has to be read against. Counting it
 * later would measure the pool at the wrong instant, and averaging it after the
 * fact would answer a different question.
 */

import { Context, Effect, Layer, Option, Ref, Semaphore } from "effect";
import { orchestratorConfig } from "./config";

/** The two kinds of work a slot is taken for. */
export const POOL_LANES = ["chat", "work"] as const;

/** Which lane a slot is taken in. Board work, or a conversation. */
export type PoolLane = (typeof POOL_LANES)[number];

/** How full one lane is, as of one instant. */
export interface PoolStats {
  /** This lane's cap. */
  readonly capacity: number;
  /** Slots held in this lane right now. At the moment of a claim it includes the claim itself. */
  readonly depth: number;
  readonly lane: PoolLane;
  /** Slots held across both lanes, which is what the box is actually running. */
  readonly totalDepth: number;
}

/** Slots nobody is holding in this lane. Zero means the next dispatch is refused. */
export const freeSlots = (stats: PoolStats) =>
  Math.max(0, stats.capacity - stats.depth);

/** Whether one more run could start in this lane right now. */
export const hasFreeSlot = (stats: PoolStats) => freeSlots(stats) > 0;

/** The work ran, holding a slot for as long as it took. */
export interface Admitted<A> {
  readonly kind: "admitted";
  /** Pool depth at the instant the slot was taken, this run included. */
  readonly stats: PoolStats;
  readonly value: A;
}

/** Every slot in the lane was busy, so nothing ran and nothing was written. */
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

/** The cap on runs in flight, per lane, and the one way through it. */
export interface WorkerPoolInterface {
  /**
   * Runs `work` if the lane has a slot free right now, and refuses if it does
   * not. The slot is released on every exit path the work can take — a value, a
   * typed failure, a defect, and the interrupt a stop command or a SIGINT turns
   * into — because a slot leaked by a killed run is a permanently smaller box.
   */
  readonly admit: <A, E, R>(
    lane: PoolLane,
    work: (stats: PoolStats) => Effect.Effect<A, E, R>
  ) => Effect.Effect<Admission<A>, E, R>;
  /** The cap on one lane. */
  readonly capacityOf: (lane: PoolLane) => number;
  /** How full one lane is right now. For the sweep's log line and for a health read. */
  readonly statsOf: (lane: PoolLane) => Effect.Effect<PoolStats>;
}

/** One held slot, which is all a run ever asks for. */
const ONE_SLOT = 1;

/** The caps for both lanes, in the order the box's total is the sum of. */
export interface PoolCapacities {
  readonly chat: number;
  readonly work: number;
}

const make = Effect.gen(function* () {
  const { maxChatConcurrency, maxConcurrency } = yield* orchestratorConfig;
  return yield* makePool({ chat: maxChatConcurrency, work: maxConcurrency });
});

/** One lane: its permits, and the depth its runs report. */
const makeLane = Effect.fnUntraced(function* (capacity: number) {
  return {
    capacity,
    // The semaphore holds the permits but will not say how many are out, and
    // the depth at claim time is a field on the run's event — so it is counted
    // here, inside the permit, where the answer cannot be off by a run that is
    // halfway through acquiring one.
    inFlight: yield* Ref.make(0),
    semaphore: yield* Semaphore.make(capacity),
  };
});

/**
 * A pool of given sizes. Exported for the check scripts and the tests that need
 * a cap of one or two without an environment behind them; everything else takes
 * the configured caps through {@link WorkerPool.layer}.
 */
export const makePool = Effect.fnUntraced(function* (
  capacities: PoolCapacities
) {
  const lanes = {
    chat: yield* makeLane(capacities.chat),
    work: yield* makeLane(capacities.work),
  } as const;

  const depths = Effect.all([
    Ref.get(lanes.chat.inFlight),
    Ref.get(lanes.work.inFlight),
  ]);

  const statsOf = (lane: PoolLane) =>
    depths.pipe(
      Effect.map(
        ([chat, work]): PoolStats => ({
          capacity: lanes[lane].capacity,
          depth: lane === "chat" ? chat : work,
          lane,
          totalDepth: chat + work,
        })
      )
    );

  const admit = <A, E, R>(
    lane: PoolLane,
    work: (slot: PoolStats) => Effect.Effect<A, E, R>
  ) =>
    lanes[lane].semaphore
      .withPermitsIfAvailable(ONE_SLOT)(
        Effect.gen(function* () {
          yield* Ref.update(lanes[lane].inFlight, (held) => held + 1);
          const slot = yield* statsOf(lane);
          const value = yield* work(slot).pipe(
            Effect.ensuring(
              Ref.update(lanes[lane].inFlight, (held) => held - 1)
            )
          );
          return { kind: "admitted", stats: slot, value } as const;
        })
      )
      .pipe(
        Effect.flatMap(
          (taken): Effect.Effect<Admission<A>> =>
            Option.isSome(taken)
              ? Effect.succeed(taken.value)
              : statsOf(lane).pipe(
                  Effect.map((current) => ({
                    kind: "at_capacity" as const,
                    stats: current,
                  }))
                )
        )
      );

  return WorkerPool.of({
    admit,
    capacityOf: (lane) => lanes[lane].capacity,
    statsOf,
  });
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

  /** A pool of fixed sizes, for a script or a test that pins the caps. */
  static readonly layerWith = (capacities: PoolCapacities) =>
    Layer.effect(WorkerPool, makePool(capacities));
}
