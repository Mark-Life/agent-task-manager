/**
 * What every harness that shells out to a vendor CLI needs, and nothing else.
 *
 * Two of the three providers are a child process reading JSONL off stdout, and
 * both want the same three things: a spawner that has not also claimed this
 * process's stdin, a failure value for a child that could not be started, and a
 * way to turn a caller's `AbortSignal` into a typed interrupt. The abort one is
 * the reason this file exists rather than being copied twice — it registers a
 * listener and has to remove it, and a second copy is a second chance to leak
 * one.
 *
 * Nothing here knows which vendor is running. The argument list, the
 * environment and the parsing all stay with the harness they belong to.
 */

import * as BunChildProcessSpawner from "@effect/platform-bun/BunChildProcessSpawner";
import * as BunFileSystem from "@effect/platform-bun/BunFileSystem";
import * as BunPath from "@effect/platform-bun/BunPath";
import { clipError } from "@workspace/telemetry";
import { Effect, Layer } from "effect";
import { Interrupted, ProviderCrashed } from "./errors";

/**
 * Bun's process spawner and the two services it is built from. Named
 * explicitly rather than taken from the aggregate platform layer, which would
 * also construct a terminal and claim the host's stdin.
 */
export const spawnerLayer = BunChildProcessSpawner.layer.pipe(
  Layer.provide(Layer.mergeAll(BunFileSystem.layer, BunPath.layer))
);

/** A failure that stopped the harness itself rather than the turn. */
export const crashed = (cause: unknown) =>
  new ProviderCrashed({ cause, message: clipError(String(cause)) });

/**
 * The caller's cancellation as a typed failure. Interrupting the fiber is the
 * ordinary way to stop a turn; this covers the case where the thing being
 * cancelled is wider than the fiber, and it has to arrive as a value so the run
 * is recorded as interrupted rather than vanishing.
 */
export const abortAsFailure = (signal: AbortSignal) =>
  Effect.callback<never, Interrupted>((resume) => {
    const fail = () =>
      resume(Effect.fail(new Interrupted({ reason: "shutdown" })));
    if (signal.aborted) {
      fail();
      return;
    }
    signal.addEventListener("abort", fail, { once: true });
    return Effect.sync(() => {
      signal.removeEventListener("abort", fail);
    });
  });
