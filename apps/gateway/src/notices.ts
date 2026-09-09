/**
 * One `LISTEN` per channel for the whole process, multicast to everyone
 * watching.
 *
 * Two things in this gateway follow a Postgres notify channel — a run's
 * timeline and the board — and both need the same four properties, none of
 * which is optional and none of which is visible in a type.
 *
 * **One listener, not one per subscriber.** `sql.listen` shares a single
 * dedicated connection through an `RcRef`, but its finalizer issues `UNLISTEN`
 * for the whole channel, so a second subscriber leaving would stop
 * notifications for every other one still watching. Multicasting one listen is
 * what avoids that, and it is also the answer to a browser tab that
 * disappears: a dropped subscriber releases a queue, and the connection is
 * released when the last of them does.
 *
 * **A reconnect that never gives up.** There is no attempt count at which
 * abandoning the channel is right, because the alternative is a process that
 * only polls. Jittered, so several gateways restarted by one outage do not
 * reconnect in lockstep.
 *
 * **A payload that will not decode is dropped, not broadcast.** It is the
 * opposite of what the orchestrator does with an unreadable dispatch notice —
 * there, any notice means sweep — because here a notice that cannot be
 * attributed would wake every open stream in the process. Each subscriber's own
 * slow tick covers the loss.
 *
 * **A notification is not delivery.** Postgres queues nothing for a listener
 * that was not connected at that instant, so silence from a quiet channel and
 * silence from a dropped socket look identical from here. That is why every
 * subscriber built on this runs a tick beside it, and why every one of them
 * re-reads from a cursor or a snapshot rather than treating a notice as the
 * thing itself.
 */

import { PgClient } from "@effect/sql-pg";
import { Effect, Predicate, Schedule, Schema, Stream } from "effect";

/** The first reconnect delay after the listening connection drops. */
const RECONNECT_BASE_MS = 1000;

/**
 * The reconnect ceiling. Half a minute, because every subscriber is covered by
 * its own tick meanwhile — retrying harder buys no latency back and hammers a
 * database that is probably the thing that is down.
 */
const RECONNECT_MAX_MS = 30_000;

/** Doubling from a second, capped, jittered, and infinite by construction. */
const reconnectSchedule = Schedule.min([
  Schedule.exponential(RECONNECT_BASE_MS),
  Schedule.spaced(RECONNECT_MAX_MS),
]).pipe(Schedule.jittered);

/**
 * How many notices the multicast holds for a subscriber that is mid-read.
 * Sized for a chatty channel rather than for a backlog: what a full buffer
 * drops is a nudge, and the next one re-reads everything anyway.
 */
const NOTICE_BUFFER = 256;

/**
 * The shared, decoded, self-healing stream of one channel's notices.
 *
 * The connection is acquired when the first subscriber arrives and released
 * after the last one leaves, so an idle gateway holds nothing and a hundred
 * dashboard tabs hold one connection between them.
 *
 * Build it over the same layer that provides the store: it needs the `PgClient`
 * the pool is behind, and a second pool would be a second gateway as far as
 * `pg_stat_activity` is concerned.
 */
export const noticeStream = <S extends Schema.Top>(options: {
  readonly channel: string;
  readonly notice: S;
}) =>
  Effect.gen(function* () {
    const sql = yield* PgClient.PgClient;
    const decode = Schema.decodeUnknownEffect(
      Schema.fromJsonString(options.notice)
    );

    const readable = (payload: string) =>
      decode(payload).pipe(
        Effect.catch((cause) =>
          Effect.as(
            Effect.logWarning("notice did not decode", {
              channel: options.channel,
              reason: String(cause),
            }),
            undefined
          )
        )
      );

    return yield* sql.listen(options.channel).pipe(
      Stream.mapEffect(readable),
      Stream.filter(Predicate.isNotUndefined),
      Stream.tapError((cause) =>
        Effect.logWarning("notice listener dropped — reconnecting", {
          channel: options.channel,
          reason: String(cause),
        })
      ),
      Stream.retry(reconnectSchedule),
      // Unreachable while the schedule above is infinite, and typed anyway: a
      // listener that somehow ends must not end every open stream with it, so
      // the failure stops here and the subscribers fall back to their ticks.
      Stream.catchCause((cause) =>
        Stream.drain(
          Stream.fromEffect(
            Effect.logError("notice listener gave up", {
              channel: options.channel,
              reason: String(cause),
            })
          )
        )
      ),
      Stream.share({ capacity: NOTICE_BUFFER, strategy: "dropping" })
    );
  });
