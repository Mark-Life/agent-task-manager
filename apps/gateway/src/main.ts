/**
 * The gateway's entrypoint: composition, startup order, and lifetime. Nothing
 * else.
 *
 * The server is a layer, so "run until interrupted" is `Layer.launch` over the
 * composed application. Everything the process does happens inside that scope,
 * which is what makes shutdown a real thing rather than a hope: the layers
 * finalize on interrupt, the OTLP exporter flushes on that finalization, and
 * the watchdog in `./shutdown` bounds how long the whole of it may take.
 *
 * The watchdog is armed before the server binds, so a process that wedges while
 * building its layers — a database that is down, a mount that is not there — is
 * still one a signal can stop.
 */

import { BunRuntime } from "@effect/platform-bun";
import { EventLog } from "@workspace/telemetry";
import { Effect } from "effect";
import { appLayer, gatewayPortConfig } from "./layers";
import { armShutdownWatchdog, shutdownGraceMsConfig } from "./shutdown";

/**
 * Boot, then serve until interrupted.
 *
 * The banner is written after the layers are up and before the server starts
 * taking traffic, and it names the ledger path rather than recomputing it, so
 * an operator can point `bun run logs` at the right file without guessing.
 */
const program = Effect.gen(function* () {
  const shutdownGraceMs = yield* shutdownGraceMsConfig;
  yield* armShutdownWatchdog(shutdownGraceMs);

  const log = yield* EventLog;
  yield* Effect.logInfo(
    `gateway up — ledger ${log.path}, shutdown grace ${shutdownGraceMs}ms`
  );

  // Never returns on its own. The line is the operator's confirmation that the
  // interrupt was seen, written while the logger layer is still up —
  // everything after it is finalizers.
  yield* Effect.never.pipe(
    Effect.onInterrupt(() =>
      Effect.logInfo(
        "shutdown requested — draining requests, flushing telemetry"
      )
    )
  );
});

if (import.meta.main) {
  BunRuntime.runMain(
    Effect.flatMap(gatewayPortConfig, (port) =>
      program.pipe(Effect.provide(appLayer(port)))
    )
  );
}
