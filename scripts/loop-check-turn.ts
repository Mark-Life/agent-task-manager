#!/usr/bin/env bun

/**
 * The turn entrypoint `bun run loop:check --docker` bundles and mounts into its
 * containers.
 *
 * It is `packages/harness/scripts/turn.ts` with one substitution: the provider
 * registry answers from `./loop-check-stub` instead of from the two vendor
 * SDKs. Everything else in a real turn still runs, inside the real image, over
 * the real mounts — the spec is read off `/run`, the Executor config is written
 * into the run's agent home, the normalized events are appended to the mounted
 * event file line by line, the `atm.turn` row goes through the registry's own
 * combinator into the ledger directory the sandbox pointed `EVENT_LOG_DIR` at,
 * the result file is written on every exit path, and the exit code comes from
 * the same table the host reads it against.
 *
 * **Faking the model and nothing else is the point.** A check that stubbed the
 * entrypoint as well would prove its own stub; a check that reached a real
 * model would cost money every time somebody ran it, and would stop being run.
 * What is left unproved is exactly that one substitution: that a vendor CLI
 * boots and answers inside the image. `bun run harness:check --live` is where
 * that is asked.
 *
 * The stubs are wrapped in the registry's own instrumentation, so a container
 * started by this file leaves the `atm.turn` row a real one leaves — which is
 * what the host then folds into the run on the id it minted.
 *
 * Not `import`ed by anything. It is a process, bundled by `loop-check.ts` to
 * the path the orchestrator mounts from, and run by the bun the image pins.
 */

import process from "node:process";
import { BunFileSystem, BunRuntime } from "@effect/platform-bun";
import {
  makeProviderRegistry,
  ProviderRegistry,
  STOP_HOOK_FLAG,
  TURN_LEDGER_SERVICE,
} from "@workspace/harness";
import { CONTAINER_ARTIFACT_DIR } from "@workspace/sandbox";
import { telemetryLayer } from "@workspace/telemetry";
import { Effect, Layer } from "effect";
import type { Teardown } from "effect/Runtime";
// Deep, and deliberately: `src/entrypoint` and `src/registry` are kept out of
// the harness barrel because a host that imported them would be running a turn
// outside the sandbox. This file is not a host — it is the thing inside the
// container, and it is bundled from here for the same reason the real
// entrypoint is: an image rebuild per commit is a tax nobody pays.
import {
  runStopHook,
  runTurn,
  specPathFrom,
} from "../packages/harness/src/entrypoint";
import { instrumented } from "../packages/harness/src/registry";
import { stubProvider } from "./loop-check-stub";

const argv = process.argv.slice(2);

/**
 * Whatever the entrypoint recorded, falling back to the exit itself — a process
 * that fell over before it could record anything must not exit zero.
 */
const teardown: Teardown = (exit, onExit) => {
  const recorded = process.exitCode;
  if (typeof recorded === "number") {
    onExit(recorded);
    return;
  }
  onExit(exit._tag === "Success" ? 0 : 1);
};

/** The one artifacts folder a contained run may write, from the mount set. */
const artifactsDir = () => CONTAINER_ARTIFACT_DIR.task;

const stubRegistry = makeProviderRegistry({
  claude: instrumented(stubProvider({ artifactsDir, id: "claude" })),
  codex: instrumented(stubProvider({ artifactsDir, id: "codex" })),
});

const turnLayer = Layer.mergeAll(
  telemetryLayer({ serviceName: TURN_LEDGER_SERVICE }),
  Layer.succeed(ProviderRegistry, stubRegistry)
).pipe(Layer.provideMerge(BunFileSystem.layer));

const main = argv.includes(STOP_HOOK_FLAG)
  ? runStopHook().pipe(Effect.provide(BunFileSystem.layer))
  : runTurn({ specPath: specPathFrom({ argv, env: process.env }) }).pipe(
      Effect.provide(turnLayer)
    );

BunRuntime.runMain(main, { teardown });
