/**
 * Shutdown, and the two ways it goes wrong.
 *
 * The ordinary path belongs to the runtime and the layer scope, not to this
 * file. `BunRuntime.runMain` interrupts the root fiber on SIGINT and SIGTERM,
 * the Bun server stops accepting and drains what it is holding, and only then
 * do the layers finalize. That last step is the one worth naming: the OTLP
 * exporter buffers and ships on scope finalization, so a process that exits
 * without closing its scope drops the last batch of events it produced —
 * exactly the ones somebody will be looking for.
 *
 * The two failures this file does own:
 *
 * **Shutdown that never finishes.** An SSE connection nobody closed, a
 * connection that will not drain. Under a supervisor that is an outage which
 * looks like a graceful stop, so the graceful path gets a budget and exits
 * non-zero when it runs out.
 *
 * **An operator who wants out now.** A second signal skips the budget: a
 * deliberate loss of the last events, chosen out loud.
 */

import process from "node:process";
import { Config, Effect } from "effect";

/**
 * How long the graceful path gets.
 *
 * Shorter than the loop's, because nothing here tears down a container: what
 * has to finish is the in-flight requests and whatever SSE streams are still
 * open, and a stream that has not noticed the interrupt in fifteen seconds is
 * not going to.
 */
const DEFAULT_SHUTDOWN_GRACE_MS = 15_000;

/** The budget for the graceful path, from the environment. */
export const shutdownGraceMsConfig = Config.int(
  "GATEWAY_SHUTDOWN_GRACE_MS"
).pipe(Config.withDefault(DEFAULT_SHUTDOWN_GRACE_MS));

/** The signals a supervisor and an operator stop this process with. */
const SHUTDOWN_SIGNALS = ["SIGINT", "SIGTERM"] as const;

/** Exit code used when shutdown had to be forced. A stop that had to be killed is not a clean stop. */
const FORCED_EXIT_CODE = 1;

/**
 * Arms the watchdog: the first signal starts the clock, the second stops
 * waiting.
 *
 * A raw signal handler rather than something inside the runtime, because the
 * deadline has to outlive the fiber it is bounding — by the time the layers are
 * finalizing there is no Effect left to interrupt, and finalizers are
 * uninterruptible by design. This is the entrypoint plumbing exception to the
 * "no `console`" rule for the same reason: the logger's own layer may already
 * be finalized when the message has to go out.
 *
 * The timer is unrefed so it can never be the thing keeping the process alive.
 */
export const armShutdownWatchdog = (graceMs: number) =>
  Effect.sync(() => {
    let armed = false;
    const onSignal = () => {
      if (armed) {
        process.stderr.write(
          "gateway: second signal — exiting now, the last events are lost\n"
        );
        process.exit(FORCED_EXIT_CODE);
        return;
      }
      armed = true;
      setTimeout(() => {
        process.stderr.write(
          `gateway: shutdown exceeded ${graceMs}ms — exiting hard\n`
        );
        process.exit(FORCED_EXIT_CODE);
      }, graceMs).unref();
    };
    for (const signal of SHUTDOWN_SIGNALS) {
      process.on(signal, onSignal);
    }
  });
