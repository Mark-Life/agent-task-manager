/**
 * Reading one of the contract's event streams for as long as a screen is open.
 *
 * The transport is the same derived client every other read here goes through,
 * so a stream is decoded by the contract's own codec and arrives as the entity
 * — `DateTime` and branded ids included — rather than as JSON somebody parses
 * at the call site. `EventSource` would have been the other way to do this, and
 * it cannot: it sends no headers, it decodes nothing, and it reconnects on its
 * own terms rather than from the cursor a timeline needs.
 *
 * What this owns is the lifetime, which is the part that is easy to get wrong
 * in a component:
 *
 * **The subscription is keyed, not closed over.** Re-subscribing on every
 * render would open a connection per keystroke; keying the effect on a string
 * the caller names — the run being watched, the board's project filter — means
 * the connection is torn down exactly when the thing being watched changes.
 * `open` is read through a ref for the same reason: it is a fresh closure every
 * render and it is not a reason to reconnect.
 *
 * **A failure is retried, an ending is not — unless there is no ending.** A
 * run's timeline closes when the run does, and reopening it would be asking a
 * finished run to finish again. A board never closes on its own, so an ending
 * there is the server having hung up on a connection nothing was written on —
 * see the gateway's idle timeout — and it is reopened promptly. A failure backs
 * off; both are jittered, so a gateway restart is not answered by every open
 * tab at once.
 */

import { Effect, Schedule, Stream } from "effect";
import { useEffect, useRef } from "react";
import { ApiClient, type ApiClientShape, run } from "@/api/runtime";

/** The first delay after a stream drops. */
const RECONNECT_BASE_MS = 1000;

/**
 * The reconnect ceiling. Half a minute, because a gateway that is not answering
 * is not helped by being asked harder, and nothing on screen is stale in a way
 * the next successful connection will not repair in full.
 */
const RECONNECT_MAX_MS = 30_000;

/** Doubling from a second, capped, and jittered so tabs do not reconnect in step. */
const reconnect = Schedule.min([
  Schedule.exponential(RECONNECT_BASE_MS),
  Schedule.spaced(RECONNECT_MAX_MS),
]).pipe(Schedule.jittered);

/**
 * How long to wait before reopening a stream that ended without failing.
 *
 * Flat rather than doubling, because this is the ordinary case and not a fault:
 * a connection nothing has been written on for a few minutes is closed by the
 * server, and reopening it is a board read, not a retry. Backing off on those
 * would leave a quiet dashboard minutes stale for no reason. Jittered all the
 * same, so a gateway restart is not answered by every tab at once.
 */
const reopen = Schedule.spaced(RECONNECT_BASE_MS).pipe(Schedule.jittered);

/** What one subscription is: what to open, what to do with what arrives. */
interface StreamOptions<A> {
  /** Off while there is nothing to watch — a finished run, a screen not shown. */
  readonly enabled: boolean;
  /**
   * Whether this stream has a terminus of its own. A board has none, so its
   * ending is a dropped connection and it is reopened; a run's timeline ends
   * when the run does, and that ending is the answer rather than a fault.
   */
  readonly endless?: boolean;
  readonly onValue: (value: A) => void;
  /** The request. Read through a ref, so it may be written inline. */
  readonly open: (
    client: ApiClientShape
  ) => Effect.Effect<Stream.Stream<A, unknown>, unknown>;
  /** What is being watched. The connection is rebuilt when this changes. */
  readonly subscription: string;
}

export const useApiStream = <A>(options: StreamOptions<A>) => {
  const latest = useRef(options);
  latest.current = options;

  const { enabled, endless = false, subscription } = options;

  useEffect(() => {
    if (!enabled) {
      return;
    }
    // Interrupting the fiber is what closes the connection: the runtime hands
    // the signal to `fetch`, so an unmounted screen is a socket the gateway
    // sees close rather than one it keeps writing into.
    const controller = new AbortController();

    const drain = Effect.gen(function* () {
      const client = yield* ApiClient;
      const values = yield* latest.current.open(client);
      yield* Stream.runForEach(values, (value) =>
        Effect.sync(() => latest.current.onValue(value))
      );
    }).pipe(Effect.scoped);

    // Reopened after a clean end only when the subscription has no terminus.
    // The retry sits inside that, so a run of failures backs off rather than
    // being counted as one reopen each.
    const following = endless
      ? drain.pipe(Effect.retry(reconnect), Effect.repeat(reopen))
      : drain.pipe(Effect.retry(reconnect));

    // Giving up is worth a line and nothing more: every stream here writes into
    // a cache an ordinary read filled, so what is on screen stays as it was and
    // the next successful connection replaces it whole.
    run(
      following.pipe(
        Effect.catchCause((cause) =>
          Effect.logWarning("stream stopped", {
            reason: String(cause),
            subscription,
          })
        )
      ),
      controller.signal
      // The only rejection left is the interrupt the cleanup below causes.
    ).catch(() => undefined);

    return () => controller.abort();
  }, [enabled, endless, subscription]);
};
