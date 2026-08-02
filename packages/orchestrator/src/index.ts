/**
 * What this package lets the rest of the system do, and — more to the point —
 * what it does not.
 *
 * The orchestrator is the loop: it watches the *in progress* column, decides
 * what may run, runs it, and writes down what happened. It has exactly one
 * consumer, `apps/loop`, and that app is deliberately thin — config, layers,
 * signals, shutdown — because everything it would otherwise contain is a
 * decision this package has already made and tested.
 *
 * Exported: the {@link Orchestrator} service and its layer, the settings a host
 * process resolves and prints, and the `atm.run` event a ledger query starts
 * from. Four things, and the shape of the seam is the argument for them: a host
 * builds the layer, calls `recover`, calls `run`, and reports what it is
 * running on.
 *
 * Not exported, deliberately, and each for its own reason.
 *
 * **Every stage of the loop.** `Dispatch`, `LeaseStore`, `WorkerPool`,
 * `QuotaGate`, `RunCommands` and the run lifecycle are built by
 * {@link Orchestrator.layer} in one order, and the order is the design — a
 * plan that reads before anything is written, a gate that refuses before a slot
 * is spent, a lease taken before a row exists, a close that runs on every exit
 * path. A caller holding `Dispatch` could claim a task without a lease; a
 * caller holding the run lifecycle could start a second container on a task
 * that already has one. Both are the failures this package exists to prevent,
 * so the way to a run is a task in a column, not a function call.
 *
 * **The pure decisions the stages are made of.** `decideRetry`, `attemptAfter`,
 * `isParked`, `buildPrompt`, `observeTurn`, `toRunEventPayload`, `foldTurnRows`
 * and the classifiers are unit-tested here and stay here. They are how a stage
 * is built, not something to build with — and each of them answers a question
 * whose second answer, computed anywhere else, is the drift.
 *
 * **The typed failures.** `DispatchFailed`, `LeaseLost`, `IngestFailed` and the
 * rest are what the loop catches from itself; neither of the two operations
 * below can fail with one. A run's failure is a row on the run, a comment on
 * the task and an `errorClass` on the event — not something a host process
 * handles.
 *
 * **`RunControl`.** The interface a run command is acted on through is
 * implemented inside {@link Orchestrator}, over the fibers it actually holds.
 * Exported, it would be a second door into starting and stopping containers,
 * and the whole point of the run-command queue is that there is one.
 *
 * The three env variables that change behaviour rather than tuning it —
 * `SANDBOX_MODE`, `DATABASE_URL`, `DATA_ROOT` — belong to `@workspace/sandbox`,
 * `@workspace/db` and the whole system respectively, and are read there. This
 * package reports the sandbox mode on its banner and never decides it.
 */

export { type OrchestratorConfig, orchestratorConfig } from "./config";
export {
  RUN_EVENT_MARKER,
  RUN_EVENT_OUTCOMES,
  RunEvent,
  type RunEventOutcome,
} from "./run-telemetry";
export {
  Orchestrator,
  type OrchestratorInterface,
  type RecoveryReport,
} from "./runtime";
