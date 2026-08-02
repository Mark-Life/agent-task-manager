/**
 * Shutdown, and the two ways it goes wrong.
 *
 * The ordinary path belongs to the runtime and the layer scope, not to this
 * file. `BunRuntime.runMain` interrupts the root fiber on SIGINT and SIGTERM,
 * grammy stops asking for updates and finishes the one it is holding, the fiber
 * map interrupts whatever manager turns are still in a container, and only then
 * do the layers finalize. That last step is the one worth naming: the OTLP
 * exporter buffers and ships on scope finalization, so a process that exits
 * without closing its scope drops the last batch of events it produced —
 * exactly the ones somebody will be looking for.
 *
 * The two failures this file does own:
 *
 * **Shutdown that never finishes.** A container ignoring SIGTERM, a long-poll
 * that will not cancel, a connection that will not drain. Under a supervisor
 * that is an outage which looks like a graceful stop, so the graceful path gets
 * a budget and exits non-zero when it runs out.
 *
 * **An operator who wants out now.** A second signal skips the budget: a
 * deliberate loss of the last events, chosen out loud.
 */

import process from "node:process";
import { Effect } from "effect";

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
          "bot: second signal — exiting now, the last events are lost\n"
        );
        process.exit(FORCED_EXIT_CODE);
        return;
      }
      armed = true;
      setTimeout(() => {
        process.stderr.write(
          `bot: shutdown exceeded ${graceMs}ms — exiting hard\n`
        );
        process.exit(FORCED_EXIT_CODE);
      }, graceMs).unref();
    };
    for (const signal of SHUTDOWN_SIGNALS) {
      process.on(signal, onSignal);
    }
  });
