/**
 * Two properties, and the second is the one that matters when the writer on the
 * other side never arrives: the wait is bounded, and what comes back at the end
 * of it is the last thing actually read rather than a failure.
 */

import { describe, expect, test } from "bun:test";
import { Effect } from "effect";
import { settle } from "./settle";

/** A read that answers a scripted sequence, then repeats its last answer. */
const scripted = <A>(values: readonly A[]) => {
  const reads: A[] = [];
  const read = Effect.sync(() => {
    const value = values[Math.min(reads.length, values.length - 1)] as A;
    reads.push(value);
    return value;
  });
  return { read, reads } as const;
};

describe("settle", () => {
  test("a value that is already settled is read once", async () => {
    const source = scripted(["finished"]);

    const value = await Effect.runPromise(
      settle({
        intervalMs: 5,
        read: source.read,
        settled: (status) => status !== "running",
      })
    );

    expect(value).toBe("finished");
    expect(source.reads).toHaveLength(1);
  });

  test("a value still being written is re-read until it settles", async () => {
    const source = scripted(["running", "running", "finished"]);

    const value = await Effect.runPromise(
      settle({
        intervalMs: 5,
        read: source.read,
        settled: (status) => status !== "running",
        windowMs: 1000,
      })
    );

    expect(value).toBe("finished");
    expect(source.reads).toEqual(["running", "running", "finished"]);
  });

  test("a writer that never arrives costs the window, not the answer", async () => {
    const source = scripted(["running"]);

    const value = await Effect.runPromise(
      settle({
        intervalMs: 5,
        read: source.read,
        settled: (status) => status !== "running",
        windowMs: 20,
      })
    );

    expect(value).toBe("running");
    // The first read, plus one per interval in the window.
    expect(source.reads).toHaveLength(5);
  });
});
