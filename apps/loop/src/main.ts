/**
 * The loop's entrypoint: composition, startup order, and lifetime. Nothing
 * else.
 *
 * Startup is a sequence and the order is load-bearing. Recovery runs before
 * anything is dispatched, because a crashed loop leaves two kinds of debris —
 * leases nobody is holding, and run rows still marked live whose process is
 * gone — and both of them lie to a fresh loop. A stale lease makes a task look
 * claimed, so it is never picked up; a run row left live makes the run look
 * unfinished forever, and `bun run logs` reports it as a start with no terminus.
 * Reclaiming and closing them first is what makes a restart a recovery rather
 * than a new set of blind spots. Only then does the trigger start listening and
 * the pool start taking work.
 *
 * Shutdown is the same property read backwards, and it belongs to the runtime:
 * see `./shutdown`.
 */

import { BunRuntime } from "@effect/platform-bun";
import { Orchestrator, orchestratorConfig } from "@workspace/orchestrator";
import { Effect } from "effect";
import { logBanner } from "./banner";
import { appLayer } from "./layers";
import { armShutdownWatchdog, shutdownGraceMsConfig } from "./shutdown";

/**
 * Boot, recover, then run until interrupted.
 *
 * The watchdog is armed before the banner rather than after recovery, so a
 * process that wedges while reclaiming leases is still one a signal can stop.
 */
const program = Effect.gen(function* () {
  const config = yield* orchestratorConfig;
  const shutdownGraceMs = yield* shutdownGraceMsConfig;
  yield* armShutdownWatchdog(shutdownGraceMs);
  yield* logBanner({ config, shutdownGraceMs });

  const orchestrator = yield* Orchestrator;

  const recovered = yield* orchestrator.recover;
  yield* Effect.logInfo(
    `recovered — ${recovered.leasesReclaimed} stale leases reclaimed, ${recovered.runsClosed} runs closed as lost`
  );

  // Never returns on its own: the trigger listens and the pool takes work until
  // the fiber is interrupted. The line is the operator's confirmation that the
  // interrupt was seen, written while the logger layer is still up — everything
  // after it is finalizers.
  yield* orchestrator.run.pipe(
    Effect.onInterrupt(() =>
      Effect.logInfo(
        "shutdown requested — stopping in-flight runs, releasing leases, flushing telemetry"
      )
    )
  );
});

if (import.meta.main) {
  BunRuntime.runMain(program.pipe(Effect.provide(appLayer)));
}
