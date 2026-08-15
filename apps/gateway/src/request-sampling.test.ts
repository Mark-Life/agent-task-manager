import { describe, expect, test } from "bun:test";
import { ConfigProvider, Effect } from "effect";
import type { FinishedRequest } from "./request-event";
import { makeRequestSampler } from "./request-sampling";

/** A plain 200 on a contract route, which is the traffic the predicate thins. */
const BORING: FinishedRequest = {
  actorKind: null,
  authBoundTaskId: null,
  authOutcome: null,
  authReason: null,
  authRequired: null,
  authScheme: null,
  authScope: null,
  bytesOut: 512,
  costUsd: null,
  durationMs: 10,
  errorClass: null,
  errorMessage: null,
  method: "GET",
  outcome: "done",
  pathShape: null,
  phase: "end",
  queueWaitMs: null,
  route: "/tasks/board",
  runId: null,
  sessionId: null,
  spanId: null,
  sse: false,
  status: 200,
  streamHeldMs: null,
  taskId: null,
  totalTokens: null,
  traceId: null,
  turns: null,
  userId: null,
  workspaceId: null,
};

const like = (patch: Partial<FinishedRequest>): FinishedRequest => ({
  ...BORING,
  ...patch,
});

/** The default the gateway ships with, stated here so the arithmetic is visible. */
const ONE_IN = 20;

/**
 * Drives a fresh sampler over a run of requests and returns what each weighed.
 * Fresh per run: the picture of the traffic is the whole state, and a shared one
 * would make each test depend on the ones before it.
 */
const weigh = (rows: readonly FinishedRequest[], oneIn: number = ONE_IN) =>
  Effect.runPromise(
    Effect.gen(function* () {
      const sampler = yield* makeRequestSampler;
      const weights: (number | null)[] = [];
      for (const row of rows) {
        weights.push(yield* sampler.rateFor(row));
      }
      return weights;
    }).pipe(
      Effect.provide(
        ConfigProvider.layer(
          ConfigProvider.fromUnknown({ GATEWAY_SAMPLE_ONE_IN: String(oneIn) })
        )
      )
    )
  );

const kept = (weights: readonly (number | null)[]) =>
  weights.filter((weight): weight is number => weight !== null);

/** A run of identical unremarkable requests, which is what a poll looks like. */
const poll = (count: number, patch: Partial<FinishedRequest> = {}) =>
  Array.from({ length: count }, () => like(patch));

describe("what the ledger keeps of the gateway's traffic", () => {
  test("thins a poll to one row in twenty, each carrying what it stands for", async () => {
    const weights = await weigh(poll(100));

    expect(kept(weights)).toHaveLength(5);
    // the turn is a counter, not a coin: the same run always keeps the same rows
    expect(weights[0]).toBe(ONE_IN);
    expect(weights[1]).toBeNull();
    expect(weights[ONE_IN]).toBe(ONE_IN);
    // and the weights add back up to the traffic, which is the point of them
    expect(kept(weights).reduce((sum, weight) => sum + weight, 0)).toBe(100);
  });

  test("keeps every ending but done, and never spends a turn on one", async () => {
    const weights = await weigh([
      like({ outcome: "errored", status: 500 }),
      like({ outcome: "rejected", status: 401 }),
      like({ outcome: "interrupted" }),
      like({ outcome: "timeout" }),
      // the first *boring* request is still the first turn, so it is kept and
      // weighs twenty — the four above stand for themselves and nothing else
      BORING,
    ]);

    expect(weights).toEqual([1, 1, 1, 1, ONE_IN]);
  });

  test("keeps a request above its route's p99 whatever the turn says", async () => {
    const weights = await weigh([...poll(200), like({ durationMs: 5000 })]);

    expect(weights.at(-1)).toBe(1);
    // and its ordinary neighbours were still thinned
    expect(kept(weights.slice(1, 200))).toHaveLength(9);
  });

  test("the tail is the route's own, not the gateway's", async () => {
    // a route that is slow by nature: 2s is this endpoint's ordinary answer.
    // 199 puts the last request off the one-in-twenty turn, so what it weighs
    // is the tail rule's answer and nothing else
    const slowRoute = { durationMs: 2000, route: "/tasks/:taskId/artifacts" };
    const weights = await weigh([...poll(199, slowRoute), like(slowRoute)]);

    // so an ordinary answer on it is thinned rather than kept as an outlier
    expect(weights.at(-1)).toBeNull();
    // while the same 2s on a route that answers in 10ms is the tail
    const onFastRoute = await weigh([...poll(199), like({ durationMs: 2000 })]);
    expect(onFastRoute.at(-1)).toBe(1);
  });

  test("keeps every event stream, which is the only row a held connection has", async () => {
    const weights = await weigh(
      poll(10, { sse: true, streamHeldMs: 3_600_000 })
    );

    expect(weights).toEqual(Array.from({ length: 10 }, () => 1));
  });

  test("one in one is the predicate turned off", async () => {
    const weights = await weigh(poll(50), 1);

    expect(kept(weights)).toHaveLength(50);
    expect(weights.every((weight) => weight === 1)).toBe(true);
  });

  test("a value below one cannot divide the turn by nothing", async () => {
    const weights = await weigh(poll(5), 0);

    expect(kept(weights)).toHaveLength(5);
  });

  test("a probe cannot grow the picture one route at a time", async () => {
    // every one of these matched no contract route, so they share the single
    // `unmatched` bucket and are thinned as one population rather than each
    // being the first request on a route of its own
    const weights = await weigh(
      Array.from({ length: 100 }, (_unused, index) =>
        like({
          outcome: "done",
          pathShape: "/*",
          route: `/wp-admin/${index}.php`,
          status: 404,
        })
      )
    );

    expect(kept(weights)).toHaveLength(5);
  });
});
