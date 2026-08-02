/**
 * Shutdown, and the two ways it goes wrong.
 *
 * The ordinary path is handled by the runtime and by the layer scope, not by
 * this file. `BunRuntime.runMain` interrupts the root fiber on SIGINT and
 * SIGTERM; the interrupt tears down the pool, so each in-flight run reaches its
 * own exit path — its terminus row is emitted, its container is torn down, its
 * lease is released — and only then do the layers finalize. That last step is
 * the one worth naming: the OTLP exporter buffers and ships on scope
 * finalization, so a process that exits without closing its scope silently
 * drops the last batch of events it produced, which are exactly the ones
 * somebody will be looking for. Everything a hard `process.exit` would save is
 * cheaper than that.
 *
 * The two failures this file does own:
 *
 * **Shutdown that never finishes.** A wedged docker daemon, a connection that
 * will not drain, a container ignoring SIGTERM — any of them leaves a process
 * that has stopped doing work and refuses to die, which under a supervisor is
 * an outage that looks like a graceful stop. So the graceful path gets a
 * budget, and when it runs out the process exits non-zero and says why.
 *
 * **An operator who wants out now.** A second signal skips the budget. That is
 * a deliberate loss of the last events, chosen out loud by the person typing
 * Ctrl-C twice.
 */

import process from "node:process";
import { Config, Effect } from "effect";

/**
 * How long the graceful path gets before the process is killed.
 *
 * Sized for what actually has to happen: interrupting a run means stopping an
 * agent CLI, tearing down its container, writing its terminus row, and
 * releasing its lease — docker's own stop grace is ten seconds per container,
 * and the pool may hold several. Forty-five seconds covers that with room for a
 * slow database, and is comfortably inside systemd's ninety-second default
 * `TimeoutStopSec`, so this process reports its own failure to stop rather than
 * being SIGKILLed while it still could have said something.
 */
const DEFAULT_SHUTDOWN_GRACE_MS = 45_000;

/** The budget for the graceful path, from the environment. */
export const shutdownGraceMsConfig = Config.int("LOOP_SHUTDOWN_GRACE_MS").pipe(
  Config.withDefault(DEFAULT_SHUTDOWN_GRACE_MS)
);

/** The signals a supervisor and an operator stop this process with. */
const SHUTDOWN_SIGNALS = ["SIGINT", "SIGTERM"] as const;

/** Exit code used when shutdown had to be forced. Non-zero: a stop that had to be killed is not a clean stop. */
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
 * If shutdown completes, the event loop drains and the timer dies with it; if
 * shutdown hangs, something else is holding the loop open and the timer still
 * fires.
 */
export const armShutdownWatchdog = (graceMs: number) =>
  Effect.sync(() => {
    let armed = false;
    const onSignal = () => {
      if (armed) {
        process.stderr.write(
          "loop: second signal — exiting now, the last events are lost\n"
        );
        process.exit(FORCED_EXIT_CODE);
        return;
      }
      armed = true;
      setTimeout(() => {
        process.stderr.write(
          `loop: shutdown exceeded ${graceMs}ms — exiting hard; a lease may be held until it goes stale\n`
        );
        process.exit(FORCED_EXIT_CODE);
      }, graceMs).unref();
    };
    for (const signal of SHUTDOWN_SIGNALS) {
      process.on(signal, onSignal);
    }
  });
