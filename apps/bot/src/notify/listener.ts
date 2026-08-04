/**
 * The bot's ear on `atm_run_event` — the channel the run-event trigger already
 * publishes on — and the slow tick that repairs what the channel loses.
 *
 * There is one channel and one trigger for run events in this system, and this
 * listens on it rather than adding a second. It does not hold an SSE
 * connection to the gateway either: that would put a second process and a
 * long-lived token on the path between a run ending and a person hearing about
 * it, and buy no isolation, because a notice is a nudge either way — every
 * wake-up re-reads the rows.
 *
 * **A notification is not delivery.** Postgres queues nothing for a listener
 * that was not connected at that instant, so a `NOTIFY` sent while the bot is
 * restarting is gone. That is what the tick beside the channel is for, and why
 * the ledger's unsent claims are re-read on it: the two together make the
 * guarantee at-least-once rather than best-effort.
 *
 * **Nothing here decides what to say.** The notice carries ids and a kind; the
 * decision is made from the rows by the summary, and the send is claimed
 * against the ledger. So a duplicate notice costs two reads and no second
 * message, and a notice for a workspace this deployment does not serve is
 * dropped before it costs even that.
 *
 * **One channel, two things to say.** A terminal event on a run with a task is
 * a notice about that task. A terminal event on a run with none is a
 * conversation's turn ending, and what a person gets is the answer it wrote —
 * the end-of-turn sync, over the listener that already exists rather than a
 * second connection holding a stream open.
 */

import { PgClient } from "@effect/sql-pg";
import {
  RunEventId,
  RunEventKind,
  RunId,
  TaskId,
  WorkspaceId,
} from "@workspace/domain";
import { Effect, Predicate, Schedule, Schema, Stream } from "effect";
import { Allowlist } from "../telegram/allowlist";
import { deliverAnswer, type QueueNotices } from "../telegram/answer";
import { Notifier } from "./send";
import { TERMINAL_EVENT_KINDS } from "./summary";

/**
 * The channel `notify_run_event` publishes on, spelled exactly as the
 * migration spells it. Re-declared rather than imported because
 * `@workspace/db` does not export it — the trigger is raw SQL — and a second
 * spelling is a listener that waits forever, which is the other half of why
 * the tick below exists at all.
 */
export const RUN_EVENT_CHANNEL = "atm_run_event";

/** How often the unsent claims are looked at, and the channel's own repair. */
export const DEFAULT_NOTIFY_REPAIR_INTERVAL_MS = 60_000;

/**
 * How many notices are worked on at once.
 *
 * Every notice waits for the close-out it was woken by — a couple of seconds
 * for a task's notice, longer for a conversation whose answer is still being
 * written — and one lane would mean a busy afternoon delivering each of those
 * waits end to end. Bounded rather than unbounded because each lane is a
 * database read and a Telegram send, and the pool behind them is small.
 */
const NOTICE_CONCURRENCY = 8;

/** The first reconnect delay after the listening connection drops. */
const RECONNECT_BASE_MS = 1000;

/** The reconnect ceiling. Half a minute; the tick covers the gap meanwhile. */
const RECONNECT_MAX_MS = 30_000;

/**
 * Doubling, capped and jittered, and infinite by construction: there is no
 * attempt count at which giving up on the channel is right, because the
 * alternative is a bot that only ever notices things a minute late.
 */
const reconnectSchedule = Schedule.min([
  Schedule.exponential(RECONNECT_BASE_MS),
  Schedule.spaced(RECONNECT_MAX_MS),
]).pipe(Schedule.jittered);

/** What the trigger puts on the wire: ids and the ordinal, never the payload. */
export const RunEventNotice = Schema.Struct({
  id: RunEventId,
  kind: RunEventKind,
  runId: RunId,
  seq: Schema.Natural,
  /** Null on a conversation's turn, which is a run attached to a thread. */
  taskId: Schema.NullOr(TaskId),
  workspaceId: WorkspaceId,
});

export interface RunEventNotice
  extends Schema.Schema.Type<typeof RunEventNotice> {}

const decodeNotice = Schema.decodeUnknownEffect(
  Schema.fromJsonString(RunEventNotice)
);

/**
 * One payload as a notice, or nothing.
 *
 * Dropped rather than raised: a line that does not decode is a trigger and a
 * listener that disagree, and killing the listener over it would stop every
 * notification instead of the one that was malformed.
 */
const noticeOf = (payload: string) =>
  decodeNotice(payload).pipe(
    Effect.catch((cause) =>
      Effect.as(
        Effect.logWarning("run event notice did not decode", {
          channel: RUN_EVENT_CHANNEL,
          reason: String(cause),
        }),
        undefined
      )
    )
  );

const isTerminal = (notice: RunEventNotice) =>
  TERMINAL_EVENT_KINDS.includes(notice.kind);

/**
 * Listen, and repair, until the fiber is interrupted.
 *
 * The two streams are merged rather than sequenced because neither may wait on
 * the other: a chatty afternoon must not delay the repair pass, and a slow
 * repair must not hold up a run that just failed. Every failure inside either
 * is logged and swallowed — one unreadable task is not a reason to stop
 * hearing about the rest of them.
 */
export const runNotifyListener = Effect.fnUntraced(function* (options: {
  /** Where the "still working" line for each thread is remembered. */
  readonly notices: QueueNotices;
  readonly repairIntervalMs?: number;
}) {
  const repairIntervalMs =
    options.repairIntervalMs ?? DEFAULT_NOTIFY_REPAIR_INTERVAL_MS;
  const sql = yield* PgClient.PgClient;
  const notifier = yield* Notifier;
  const allowlist = yield* Allowlist;

  /** A worker run ended: a notice about its task, claimed on the ledger. */
  const onTaskEvent = (notice: RunEventNotice & { readonly taskId: TaskId }) =>
    notifier.deliver({
      eventKind: notice.kind,
      runId: notice.runId,
      taskId: notice.taskId,
      workspaceId: notice.workspaceId,
    });

  const onNotice = Effect.fnUntraced(
    function* (notice: RunEventNotice) {
      const { taskId } = notice;
      if (taskId === null) {
        yield* deliverAnswer({
          notices: options.notices,
          run: { id: notice.runId, workspaceId: notice.workspaceId },
        });
        return;
      }
      yield* onTaskEvent({ ...notice, taskId });
    },
    (effect, notice) =>
      effect.pipe(
        Effect.asVoid,
        Effect.catchCause((cause) =>
          Effect.logWarning("notification failed", cause).pipe(
            Effect.annotateLogs({
              runId: notice.runId,
              taskId: notice.taskId,
            })
          )
        )
      )
  );

  const notices = sql.listen(RUN_EVENT_CHANNEL).pipe(
    Stream.mapEffect(noticeOf),
    Stream.filter(Predicate.isNotUndefined),
    Stream.filter(isTerminal),
    // A workspace nobody can be told about is a workspace not worth reading
    // rows for. The allow-list is the whole population this bot serves.
    Stream.filter((notice) =>
      allowlist.workspaceIds.includes(notice.workspaceId)
    ),
    Stream.tapError((cause) =>
      Effect.logWarning("run event listener dropped — reconnecting", {
        channel: RUN_EVENT_CHANNEL,
        reason: String(cause),
      })
    ),
    Stream.retry(reconnectSchedule),
    Stream.mapEffect(onNotice, { concurrency: NOTICE_CONCURRENCY })
  );

  // `Stream.tick` emits immediately, so a restart's first act is to look at
  // what the process before it claimed and never delivered.
  const repairs = Stream.tick(repairIntervalMs).pipe(
    Stream.mapEffect(() =>
      Effect.forEach(allowlist.workspaceIds, (workspaceId) =>
        notifier.repair({ workspaceId }).pipe(
          Effect.asVoid,
          Effect.catchCause((cause) =>
            Effect.logWarning("notification repair pass failed", cause).pipe(
              Effect.annotateLogs({ workspaceId })
            )
          )
        )
      )
    )
  );

  yield* Stream.runDrain(Stream.merge(notices, repairs));
});
