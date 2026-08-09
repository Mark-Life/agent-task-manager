/**
 * The composition root. Every service the loop runs on is built here, once, and
 * finalized once.
 *
 * This is the whole reason `apps/loop` exists as an app rather than as a
 * function in `@workspace/orchestrator`: the orchestrator declares what it
 * needs, and this file decides what satisfies it — which sandbox
 * implementation, which database, which telemetry sinks, which actor its writes
 * are attributed to. No business logic lives here, and none should; a branch in
 * this file is a decision the orchestrator should have been making.
 *
 * The build order is the dependency order, bottom up:
 *
 *   platform (Bun's filesystem, path, crypto, child processes)
 *     └─ telemetry — logger, the JSONL ledger, the config-gated OTLP forwarder
 *          └─ store, sandbox, workspace, provider registry, actor
 *               └─ Orchestrator
 *
 * Everything is exposed with `provideMerge` rather than hidden with `provide`,
 * because the entrypoint legitimately reaches two of the lower layers: the
 * logger the banner is written through, and the `EventLog` whose path the
 * banner prints. Nothing else in the process should reach past `Orchestrator`.
 */

import { BunServices } from "@effect/platform-bun";
import { CurrentActor, storeLayer } from "@workspace/db";
import { providerRegistryLayer } from "@workspace/harness";
import { Orchestrator } from "@workspace/orchestrator";
import { ScopeHistory, sandboxLayer, workspaceLayer } from "@workspace/sandbox";
import { EventLog, telemetryLayer } from "@workspace/telemetry";
import { Layer } from "effect";
import { LOOP_INSTANCE, orchestratorActor, SERVICE_NAME } from "./identity";

/**
 * The logger, the durable ledger and the OTLP forwarder, over Bun's platform
 * services.
 *
 * The second `EventLog` is a read handle, not a second writer: the emitter
 * inside `telemetryLayer` owns the appends, and this one exists so the banner
 * can print the path an operator points `bun run logs` at instead of the app
 * recomputing it from `DATA_ROOT` and getting it subtly wrong.
 */
const observabilityLayer = Layer.mergeAll(
  telemetryLayer({ serviceName: SERVICE_NAME }),
  EventLog.layer({ serviceName: SERVICE_NAME })
).pipe(Layer.provideMerge(BunServices.layer));

/**
 * What the orchestrator dispatches with: the repositories over one connection
 * pool, a sandbox, somewhere to materialize a run's directories, somewhere to
 * keep what the shared folders held before the run, the harness table, and the
 * actor every write this process makes is attributed to.
 *
 * `sandboxLayer` reads `SANDBOX_MODE` itself and hands back docker or local.
 * The choice is not made here and must not be — the moment this file can ask
 * which implementation it got, dispatch grows a branch and the escape hatch
 * stops being the same code path.
 */
const dispatchServicesLayer = Layer.mergeAll(
  CurrentActor.layer(orchestratorActor(LOOP_INSTANCE)),
  providerRegistryLayer,
  sandboxLayer,
  ScopeHistory.layer,
  storeLayer({ applicationName: SERVICE_NAME }),
  workspaceLayer
);

/**
 * The whole process, as one layer. Provide it to the entrypoint effect and
 * nothing else: a second build would mean a second connection pool and a second
 * ledger handle claiming to be the same loop.
 */
export const appLayer = Orchestrator.layer.pipe(
  // The dispatch services go in and stay in. Nothing in this process reaches
  // past `Orchestrator`, and exposing them would put the connection pool and
  // the drizzle handle behind it in the environment of an entrypoint that has
  // no business holding either.
  Layer.provide(dispatchServicesLayer),
  Layer.provideMerge(observabilityLayer)
);
