/**
 * When the loop looks for work. Four sources, one stream, and no one of them is
 * allowed to be the only one.
 *
 * `LISTEN/NOTIFY` is what makes moving a card to *in progress* start a run at
 * once: the first migration puts an `AFTER INSERT OR UPDATE` trigger on `task`
 * that fires only when the row lands in that column, and it carries ids rather
 * than a payload because `NOTIFY` has a hard 8000-byte limit. That gives
 * immediacy and nothing else — a notification is delivered to whoever is
 * listening at that instant, is never queued, and is simply lost if the
 * connection dropped between the `LISTEN` and the insert. Silence from a
 * healthy board and silence from a dead socket look identical from here.
 *
 * So a slow poll runs beside it. It is the safety net for exactly that failure
 * and is deliberately unhurried: half a minute of extra latency on the rare
 * dropped-notification path is invisible next to a container start, while a
 * fast poll would be a query per second forever for a board that changes a few
 * times a day. Between them the guarantee is "a task never sits in *in
 * progress* forever", which is stronger than either alone.
 *
 * The third source is the run-command queue, on its own channel from the same
 * migration. A sweep drains that queue before it reads the column, so waking on
 * a written command is what makes Stop an immediate thing rather than something
 * that happens by the next poll — and the poll still covers it, for the same
 * reason it covers the other channel.
 *
 * The fourth is a message arriving in a conversation, on a channel of its own
 * from the chat-dispatch migration. It is the same shape as a card entering the
 * column, and deliberately so: the bot writes the row and stops, and this is
 * what turns that row into a turn. A person waiting half a minute for a poll to
 * notice them would be the one place the poll's latency is visible.
 *
 * Nothing here decides anything. A signal is a nudge to sweep, and the sweep
 * reads the column through `TaskRepo.byStatus` whichever source woke it — the
 * notice's ids say which workspace changed, never which task to run. That is
 * what keeps one dispatch order in the system instead of a poll order and a
 * notify order that disagree under load.
 */

import { PgClient } from "@effect/sql-pg";
import { TaskId, WorkspaceId } from "@workspace/domain";
import { Effect, Schedule, Schema, Stream } from "effect";

/**
 * The channel `notify_task_dispatch` publishes on, spelled exactly as the
 * `20260801214709_triggers_and_grants` migration spells it.
 *
 * It lives here rather than being imported because `@workspace/db` does not
 * export it: the trigger is raw SQL in a custom migration, and the package's
 * surface is repositories. A second spelling of this string is a loop that
 * listens forever and never wakes, which is why the constant is one line under
 * one name and the poll below exists regardless.
 */
export const DISPATCH_CHANNEL = "atm_task_dispatch";

/**
 * The channel `notify_run_command` publishes on, from the same migration.
 *
 * A stop is a row, and a row nobody reads until the next poll is a Stop button
 * that takes half a minute to do anything. Waking on it costs one more `LISTEN`
 * and makes an intervention as immediate as a card entering the column, which
 * is what an operator watching a run go wrong expects of it.
 */
export const COMMAND_CHANNEL = "atm_run_command";

/**
 * The channel `notify_chat_dispatch` publishes on, from the chat-dispatch
 * migration, on every `chat_message` insert where the role is `user`.
 *
 * Here for the same reason as the other two: the trigger is raw SQL in a custom
 * migration and `@workspace/db` exports repositories rather than channel names.
 */
export const CHAT_CHANNEL = "atm_chat_dispatch";

/**
 * What the trigger puts on the wire. Ids and the rank, no task body — the
 * payload limit is small enough that carrying anything real would fail at
 * exactly the moment a task got interesting, so a listener reads the row.
 */
export const DispatchNotice = Schema.Struct({
  /** The task's position in its column at the moment it entered. Zero for a chat notice. */
  rank: Schema.Number,
  /** Null on a chat notice, which names a workspace and nothing else. */
  taskId: Schema.NullOr(TaskId),
  workspaceId: WorkspaceId,
});

export interface DispatchNotice
  extends Schema.Schema.Type<typeof DispatchNotice> {}

/** Where a wake-up came from. On the signal so a sweep can be attributed. */
export const DISPATCH_SIGNAL_SOURCES = [
  "chat",
  "command",
  "notify",
  "poll",
] as const;

/** Which of the two sources produced a signal. */
export const DispatchSignalSource = Schema.Literals(DISPATCH_SIGNAL_SOURCES);
export type DispatchSignalSource = typeof DispatchSignalSource.Type;

/**
 * One nudge to sweep. The notice is present only on the notify path, and even
 * there it is context rather than instruction: it names the workspace whose
 * board moved, and the sweep still reads the whole column in rank order.
 */
export interface DispatchSignal {
  readonly notice: DispatchNotice | null;
  readonly source: DispatchSignalSource;
}

/** The first reconnect delay after the listening connection drops. */
const RECONNECT_BASE_MS = 1000;

/**
 * The reconnect ceiling. Half a minute, because a listener that is down is
 * covered by the poll at the same cadence — retrying harder than that buys no
 * latency back and hammers a database that is probably the thing that is down.
 */
const RECONNECT_MAX_MS = 30_000;

/**
 * Reconnect backoff: doubling from a second, capped, and jittered so several
 * loops restarted by the same outage do not reconnect in lockstep. Infinite by
 * construction — there is no attempt count at which giving up on the trigger is
 * the right answer, because the alternative is a loop that only ever polls and
 * never says so.
 */
const reconnectSchedule = Schedule.min([
  Schedule.exponential(RECONNECT_BASE_MS),
  Schedule.spaced(RECONNECT_MAX_MS),
]).pipe(Schedule.jittered);

/**
 * The service key, which the library holds under the same name as the module
 * that exports it. Named once here so the listen below reads as one thing.
 */
const PgClientService = PgClient.PgClient;

const decodeNotice = Schema.decodeUnknownEffect(
  Schema.fromJsonString(DispatchNotice)
);

/** A wake-up with nothing readable attached, which is still a wake-up. */
const BARE_NOTIFY: DispatchSignal = { notice: null, source: "notify" };

/**
 * Turns one payload into a signal, and refuses to lose the wake-up over it. A
 * payload this process cannot decode still means a task entered the column —
 * the trigger only fires on that — so the shape is dropped, the surprise is
 * logged once, and the sweep happens anyway.
 */
const signalOf = (payload: string) =>
  decodeNotice(payload).pipe(
    Effect.map((notice): DispatchSignal => ({ notice, source: "notify" })),
    Effect.catch((error) =>
      Effect.as(
        Effect.logWarning("dispatch notice did not decode", {
          channel: DISPATCH_CHANNEL,
          reason: String(error),
        }),
        BARE_NOTIFY
      )
    )
  );

/**
 * One channel, reconnecting forever.
 *
 * `Stream.retry` re-runs the stream's acquire, which is the whole point: a
 * dropped connection means the `LISTEN` is gone with it, and re-listening is
 * the only repair. Everything published during the gap is lost — Postgres
 * queues nothing for a listener that is not there — and that loss is precisely
 * what {@link pollSignals} is the answer to.
 */
const listening = (
  channel: string,
  onPayload: (payload: string) => Effect.Effect<DispatchSignal>
) =>
  Stream.unwrap(PgClientService.useSync((sql) => sql.listen(channel))).pipe(
    Stream.mapEffect(onPayload),
    Stream.tapError((error) =>
      Effect.logWarning("dispatch listener dropped — reconnecting", {
        channel,
        reason: String(error),
      })
    ),
    Stream.retry(reconnectSchedule)
  );

/** Cards entering *in progress*. */
export const notifySignals = listening(DISPATCH_CHANNEL, signalOf);

/** A command signal says only that the queue is not empty. */
const COMMAND_SIGNAL: DispatchSignal = { notice: null, source: "command" };

/**
 * Somebody asked for a stop, a rerun or a session.
 *
 * The payload is dropped rather than decoded: the sweep drains the queue in
 * write order and the repository hands each row to exactly one claimant, so the
 * ids on the notice are ones the drain is about to read anyway — and a notice
 * this process could not parse would still mean a command is waiting.
 */
export const commandSignals = listening(COMMAND_CHANNEL, () =>
  Effect.succeed(COMMAND_SIGNAL)
);

/**
 * What the chat trigger puts on the wire. The message and its thread are on it
 * for a human reading `pg_notify` output; the sweep reads only the workspace,
 * because the chat queue is a query over every thread with something
 * unanswered, in the order they have been waiting.
 */
const ChatNotice = Schema.Struct({
  messageId: Schema.String,
  threadId: Schema.String,
  workspaceId: WorkspaceId,
});

const decodeChatNotice = Schema.decodeUnknownEffect(
  Schema.fromJsonString(ChatNotice)
);

/** A wake-up with nothing readable attached, which is still a wake-up. */
const BARE_CHAT: DispatchSignal = { notice: null, source: "chat" };

/** A chat signal says only that somebody said something in this workspace. */
const chatSignalOf = (payload: string) =>
  decodeChatNotice(payload).pipe(
    Effect.map(
      (notice): DispatchSignal => ({
        notice: { rank: 0, taskId: null, workspaceId: notice.workspaceId },
        source: "chat",
      })
    ),
    Effect.catch((error) =>
      Effect.as(
        Effect.logWarning("chat notice did not decode", {
          channel: CHAT_CHANNEL,
          reason: String(error),
        }),
        BARE_CHAT
      )
    )
  );

/**
 * Somebody said something in a conversation.
 *
 * The payload names the workspace, which is all the sweep reads off any notice:
 * the chat queue is a query over the threads with something unanswered, in the
 * order they have been waiting, and a notice naming one thread would be a
 * second ordering that eventually disagrees with it.
 */
export const chatSignals = listening(CHAT_CHANNEL, chatSignalOf);

/**
 * The safety net. `Stream.tick` emits once immediately and then on the
 * interval, so the first tick doubles as the startup sweep — a loop that
 * restarts after a crash picks up whatever landed in the column while it was
 * gone without waiting a poll interval to notice.
 */
export const pollSignals = (pollIntervalMs: number) =>
  Stream.map(
    Stream.tick(pollIntervalMs),
    (): DispatchSignal => ({ notice: null, source: "poll" })
  );

/**
 * Every reason to sweep, in one stream. Merged rather than raced: a notify
 * arriving while a poll tick is in flight is two signals, and the sweep is
 * idempotent — it drains the queue, reads the column and claims what it can —
 * so the cost of a redundant one is a query, while the cost of dropping one is
 * a task that waits.
 */
export const dispatchSignals = (options: { readonly pollIntervalMs: number }) =>
  Stream.mergeAll(
    [
      pollSignals(options.pollIntervalMs),
      notifySignals,
      commandSignals,
      chatSignals,
    ],
    { concurrency: "unbounded" }
  );
