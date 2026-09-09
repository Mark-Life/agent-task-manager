/**
 * The live tail of a run's timeline, over the database's own notify channel.
 *
 * A run event is written once and read by everyone: the paged endpoint replays
 * it, this one follows it. Both order by the `seq` the container wrote, so a
 * client pages back through what already happened, notes the cursor the last
 * page returned, opens the stream from there, and misses nothing in the gap.
 *
 * Two properties are what make that true, and each costs something.
 *
 * **The cursor is the whole protocol.** A notification carries ids and never a
 * payload — `NOTIFY` has a hard 8000-byte limit and a run event's blob is
 * allowed sixty times that — so a notice is a nudge to read, never the thing
 * read. Every wake-up runs the same query: everything after the cursor. That
 * makes a duplicate notice free, a dropped notice recoverable, and replay from
 * an arbitrary `afterSeq` the same code path as the live tail.
 *
 * **A notification is not delivery.** Postgres queues nothing for a listener
 * that was not connected at that instant, so silence from a quiet run and
 * silence from a dropped socket look identical from here. A slow tick runs
 * beside the channel for exactly that failure, and because the drain is
 * cursor-based, the tick is a repair rather than a duplicate.
 *
 * The listener under all of it — one `LISTEN` for the process, reconnecting
 * forever, shared by every subscriber — is `./notices`, and the board's stream
 * is built on the same thing.
 *
 * A generic OpenAPI consumer sees `text/event-stream` and the event schema, and
 * nothing in the document tells it to hold the connection open. Streaming to an
 * external agent is therefore a deliberate integration and not a free
 * consequence of the spec.
 */

import { RunEventRepo, RunRepo } from "@workspace/db";
import type { RunEvent } from "@workspace/domain";
import {
  isRunLive,
  RunEventId,
  RunEventKind,
  RunId,
  TaskId,
  WorkspaceId,
} from "@workspace/domain";
import { Context, Effect, Layer, Option, Ref, Schema, Stream } from "effect";
import { noticeStream } from "./notices";

/**
 * The channel `notify_run_event` publishes on, spelled exactly as the
 * `20260801214709_triggers_and_grants` migration spells it.
 *
 * It lives here rather than being imported because `@workspace/db` does not
 * export it: the trigger is raw SQL in a custom migration and that package's
 * surface is repositories. A second spelling of this string is a stream that
 * listens forever and never wakes, which is why the constant is one line under
 * one name and the tick below exists regardless.
 */
export const RUN_EVENT_CHANNEL = "atm_run_event";

/**
 * What the trigger puts on the wire. Ids and the ordinal, never the payload.
 *
 * `taskId` is denormalized onto the row for this: a subscriber filters one
 * task's traffic out of the channel without a join, and without reading a row
 * to find out whether it wanted it.
 */
export const RunEventNotice = Schema.Struct({
  id: RunEventId,
  kind: RunEventKind,
  runId: RunId,
  seq: Schema.Natural,
  taskId: TaskId,
  workspaceId: WorkspaceId,
});

export interface RunEventNotice
  extends Schema.Schema.Type<typeof RunEventNotice> {}

const make = Effect.map(
  noticeStream({ channel: RUN_EVENT_CHANNEL, notice: RunEventNotice }),
  (notices) => RunEventNotices.of({ notices })
);

/**
 * One `LISTEN atm_run_event` for the whole process, multicast to every open
 * stream. See `./notices` for what that buys and what it costs.
 */
export class RunEventNotices extends Context.Service<
  RunEventNotices,
  { readonly notices: Stream.Stream<RunEventNotice> }
>()("gateway/RunEventNotices") {
  static readonly layer = Layer.effect(RunEventNotices, make);
}

/** Which run's timeline to follow, and from where. */
export interface RunEventSubscription {
  /** Emit only events after this ordinal. Absent starts at the beginning. */
  readonly afterSeq?: number;
  readonly runId: RunId;
  readonly taskId: TaskId;
  readonly workspaceId: WorkspaceId;
}

/**
 * How much of the backlog one query pulls. A client reconnecting to a long run
 * catches up in pages rather than in one read, so the memory a subscriber costs
 * is bounded by this and not by how long the run has been going.
 */
const DRAIN_PAGE = 500;

/**
 * How often a subscriber reads regardless of the channel. Slow on purpose: it
 * is the repair for a notification lost to a dropped socket, and the bound on
 * how long a run that ended without saying so keeps a stream open. A run that
 * is talking is delivered by the channel and never waits for this.
 */
const REFRESH_INTERVAL_MS = 10_000;

/** The kinds a run's timeline ends on. Nothing is appended after one of these. */
const TERMINAL_KINDS: readonly RunEventKind[] = [
  "failed",
  "finished",
  "stopped",
];

const isTerminal = (event: RunEvent) =>
  TERMINAL_KINDS.includes(event.payload.kind);

/** One read's worth of timeline, and whether it was the last one. */
interface EventBatch {
  readonly closed: boolean;
  readonly events: readonly RunEvent[];
}

/**
 * Whether the run is over without having said so.
 *
 * Asked only when a drain came back empty, so a talking run never pays for it
 * and an idle one pays a primary-key lookup per tick. It is what closes the
 * stream on a run that died in a way that wrote no terminal event — otherwise
 * the promise that a finished run's stream ends would hold only for the runs
 * that ended tidily. A run deleted underneath a subscriber is over too.
 */
const hasEnded = (options: {
  readonly runs: RunRepo["Service"];
  readonly subscription: RunEventSubscription;
}) =>
  options.runs
    .byId({
      id: options.subscription.runId,
      workspaceId: options.subscription.workspaceId,
    })
    .pipe(
      Effect.map((run) => !isRunLive(run)),
      Effect.catchTag("Db.NotFound", () => Effect.succeed(true)),
      Effect.orDie
    );

/**
 * Everything after the cursor, in pages, advancing the cursor as it goes.
 *
 * The cursor is read from the ref rather than carried as pagination state
 * because it outlives the drain: it is what the next wake-up starts from, and
 * it is the only reason a duplicate notice costs one empty query instead of a
 * replayed timeline.
 */
const pagesAfter = (options: {
  readonly cursor: Ref.Ref<number | undefined>;
  readonly events: RunEventRepo["Service"];
  readonly runs: RunRepo["Service"];
  readonly subscription: RunEventSubscription;
}) =>
  // The pagination state is `null` throughout: what advances between pages is
  // the ref, not the seed, and there is nothing else a page needs to know.
  Stream.paginate(null, () =>
    Effect.gen(function* () {
      const afterSeq = yield* Ref.get(options.cursor);
      const page = yield* options.events
        .listByRun({
          afterSeq,
          limit: DRAIN_PAGE,
          runId: options.subscription.runId,
          workspaceId: options.subscription.workspaceId,
        })
        .pipe(Effect.orDie);

      const last = page.at(-1);
      if (last !== undefined) {
        yield* Ref.set(options.cursor, last.seq);
      }

      const closed =
        last === undefined
          ? yield* hasEnded({
              runs: options.runs,
              subscription: options.subscription,
            })
          : isTerminal(last);
      const batch: EventBatch = { closed, events: page };
      const more = !closed && page.length === DRAIN_PAGE;

      return [[batch], more ? Option.some(null) : Option.none()] as const;
    })
  );

/**
 * The stream a subscriber actually consumes, before its services are pinned.
 *
 * Two things wake a drain and neither is trusted alone: the channel, filtered
 * to this run, and a tick that emits once immediately — which is what makes the
 * first drain the catch-up from `afterSeq` rather than a separate phase with a
 * race in the middle of it.
 *
 * The wake-ups go through a one-slot sliding buffer. Drains run one at a time,
 * so a run emitting faster than the database answers would otherwise queue a
 * drain per event; sliding keeps the newest nudge and drops the rest, and since
 * every drain reads everything after the cursor, a dropped nudge costs nothing.
 */
const liveEvents = (subscription: RunEventSubscription) =>
  Stream.unwrap(
    Effect.gen(function* () {
      const { notices } = yield* RunEventNotices;
      const events = yield* RunEventRepo;
      const runs = yield* RunRepo;
      const cursor = yield* Ref.make(subscription.afterSeq);

      const mine = Stream.filter(
        notices,
        (notice) =>
          notice.runId === subscription.runId &&
          notice.taskId === subscription.taskId &&
          notice.workspaceId === subscription.workspaceId
      );

      return Stream.merge(Stream.tick(REFRESH_INTERVAL_MS), mine).pipe(
        Stream.buffer({ capacity: 1, strategy: "sliding" }),
        Stream.flatMap(() =>
          pagesAfter({ cursor, events, runs, subscription })
        ),
        Stream.takeUntil((batch) => batch.closed),
        Stream.flatMap((batch) => Stream.fromIterable(batch.events))
      );
    })
  );

/**
 * A run's events from `afterSeq` onwards, as they land, ending when the run
 * does.
 *
 * The services are read here and pinned onto the stream, because the endpoint's
 * success schema is a stream that requires none: the handler holds the request
 * context, and what it hands back has to be able to outlive the effect that
 * produced it without carrying an environment nobody is left to provide.
 *
 * Failing is not among the things this can do. A store that will not answer is
 * a defect rather than a message on a wire that has already sent a 200, and
 * every recoverable failure below — a lost listener, a deleted run — is either
 * repaired or is the end of the stream.
 */
export const runEventStream = (subscription: RunEventSubscription) =>
  Effect.map(
    Effect.context<RunEventNotices | RunEventRepo | RunRepo>(),
    (services) => Stream.provideContext(liveEvents(subscription), services)
  );
