import { describe, expect, test } from "bun:test";
import { Effect, Metric } from "effect";
import { boundedCounter, boundedHistogram, orNone } from "./metrics";

const OUTCOMES = ["done", "errored", "interrupted"] as const;
const PROVIDERS = ["claude", "codex"] as const;

// An unbounded tag cannot reach a metric: it belongs on the event only.
// @ts-expect-error repo is not an enumerable tag
boundedCounter("atm_test_rejected_total", { tags: { repo: ["a", "b"] } });

const findSnapshot = (id: string) =>
  Effect.map(Metric.snapshot, (snapshots) =>
    snapshots.find((snapshot) => snapshot.id === id)
  );

describe("orNone", () => {
  test("maps absent, empty and blank values to the sentinel", () => {
    expect(orNone(null)).toBe("none");
    expect(orNone(undefined)).toBe("none");
    expect(orNone("")).toBe("none");
    expect(orNone("   ")).toBe("none");
  });

  test("keeps a present value, trimmed", () => {
    expect(orNone(" claude ")).toBe("claude");
  });
});

describe("boundedCounter", () => {
  test("pins its attribute key set, with the sentinel for an absent tag", async () => {
    const runs = boundedCounter("atm_test_runs_total", {
      description: "runs by outcome",
      tags: { outcome: OUTCOMES, provider: PROVIDERS },
    });

    const snapshot = await Effect.runPromise(
      Effect.andThen(
        runs.increment({ outcome: "done", provider: null }),
        findSnapshot("atm_test_runs_total")
      )
    );

    expect(Object.keys(snapshot?.attributes ?? {}).sort()).toEqual([
      "outcome",
      "provider",
    ]);
    expect(snapshot?.attributes?.provider).toBe("none");
    expect(snapshot?.attributes?.outcome).toBe("done");
    expect(runs.tagKeys).toEqual(["outcome", "provider"]);
  });

  test("counts", async () => {
    const parked = boundedCounter("atm_test_parked_total", {
      tags: { outcome: OUTCOMES },
    });

    const snapshot = await Effect.runPromise(
      Effect.andThen(
        Effect.andThen(
          parked.increment({ outcome: "errored" }),
          parked.increment({ outcome: "errored" }, 2)
        ),
        findSnapshot("atm_test_parked_total")
      )
    );

    expect(snapshot?.state).toMatchObject({ count: 3 });
  });
});

describe("boundedHistogram", () => {
  test("pins its attribute key set", async () => {
    const duration = boundedHistogram("atm_test_duration_ms", {
      boundaries: [100, 1000, 10_000],
      tags: { outcome: OUTCOMES },
    });

    const snapshot = await Effect.runPromise(
      Effect.andThen(
        duration.record({ outcome: "done" }, 250),
        findSnapshot("atm_test_duration_ms")
      )
    );

    expect(Object.keys(snapshot?.attributes ?? {}).sort()).toEqual(["outcome"]);
    expect(snapshot?.state).toMatchObject({ count: 1 });
  });
});
