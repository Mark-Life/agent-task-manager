#!/usr/bin/env bun
/**
 * What the container runs. Bundled to a single file by
 * `scripts/build-entrypoint.ts`, mounted read-only, and invoked as pid 1's
 * child by the sandbox.
 *
 * Its whole job is to choose a mode, provide the services, and hand the process
 * back an exit code. The turn is `src/entrypoint.ts` and the stop rule is
 * `src/stop-hook.ts`; nothing is decided here.
 *
 * Two modes, one file, because the mount set carries exactly one. The default
 * is the turn. `--stop-hook` is the process each provider spawns when the agent
 * tries to end its turn, and it is deliberately given the filesystem and
 * nothing else: it runs on the critical path of every ending, several times a
 * run, and building a telemetry emitter to answer one filesystem question would
 * be latency paid for nothing.
 *
 * The exit code comes from `process.exitCode`, which the entrypoint sets inside
 * an uninterruptible region. An interrupted run — a stop command, a `docker
 * stop` — never returns a value through its own fiber, and the code for it
 * would otherwise be lost exactly when it is most informative.
 */

import process from "node:process";
import { BunFileSystem, BunRuntime } from "@effect/platform-bun";
import { telemetryLayer } from "@workspace/telemetry";
import { Effect, Layer } from "effect";
import type { Teardown } from "effect/Runtime";
import { runStopHook, runTurn, specPathFrom } from "../src/entrypoint";
import { providerRegistryLayer } from "../src/registry";
import { STOP_HOOK_FLAG, TURN_LEDGER_SERVICE } from "../src/turn-spec";

const argv = process.argv.slice(2);

/**
 * Whatever the entrypoint recorded, falling back to the exit itself. The
 * fallback matters: a process that fell over before it could record anything
 * must not exit zero.
 */
const teardown: Teardown = (exit, onExit) => {
  const recorded = process.exitCode;
  if (typeof recorded === "number") {
    onExit(recorded);
    return;
  }
  onExit(exit._tag === "Success" ? 0 : 1);
};

/**
 * The turn's services. `telemetryLayer` is what carries the `atm.turn` row into
 * the ledger directory the sandbox pointed `EVENT_LOG_DIR` at — inside the run
 * mount, and so on the host. Its OTLP half stays dormant, because the sandbox
 * strips every `OTEL_*` variable on the way in.
 */
const turnLayer = Layer.mergeAll(
  telemetryLayer({ serviceName: TURN_LEDGER_SERVICE }),
  providerRegistryLayer
).pipe(Layer.provideMerge(BunFileSystem.layer));

const main = argv.includes(STOP_HOOK_FLAG)
  ? runStopHook().pipe(Effect.provide(BunFileSystem.layer))
  : runTurn({
      specPath: specPathFrom({ argv, env: process.env }),
    }).pipe(Effect.provide(turnLayer));

BunRuntime.runMain(main, { teardown });
