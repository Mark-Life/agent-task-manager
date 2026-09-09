/**
 * The board as it changes, over the database's own notify channel.
 *
 * A dashboard used to ask for the board every ten seconds and, on top of that,
 * once per in-progress card for the run on it — twenty-four requests a minute
 * per open tab whether or not anything had moved, and the largest single source
 * of rows in the gateway's ledger. This is the other half of removing that: the
 * card's live run is now on the board's own read, and the board itself arrives
 * when it changes instead of being asked for.
 *
 * Three decisions, and each is the reason something below is the way it is.
 *
 * **What is sent is a board, not a card.** A notice says a workspace's board
 * moved and nothing else; the answer is the same five columns the paged
 * endpoint returns, read through the same function, so the two cannot disagree
 * about the order a column is in or which cards a filter hides. Sending the
 * card that changed would put the column, the rank and the fixture rules on the
 * client as a second implementation of what the server just did.
 *
 * **The read is authorized once, at subscribe.** The workspace comes off the
 * principal the middleware resolved and is closed over for the life of the
 * connection, which is the same scope the credential has. Nothing on the
 * channel reaches a subscriber: a notice is a nudge to re-read, and the re-read
 * is the same one an ordinary request makes.
 *
 * **A snapshot that has not changed is not sent.** Two things can wake a read
 * and neither is trusted alone — the channel, and a slow tick that repairs a
 * notification lost to a dropped socket. Between them a quiet board would emit
 * a copy of itself every {@link REFRESH_INTERVAL_MS}, so the last one sent is
 * compared against the next and only a difference goes out. An open dashboard
 * on a board nobody is touching therefore costs one connection and no traffic.
 */

import type { BoardColumn } from "@workspace/api";
import { TaskId, WorkspaceId } from "@workspace/domain";
import { Context, Effect, Layer, Schema, Stream } from "effect";
import { noticeStream } from "./notices";

/**
 * The channel `notify_board_task` and `notify_board_run` publish on, spelled
 * exactly as the `20260909122359_board_notify` migration spells it.
 *
 * It lives here rather than being imported because `@workspace/db` does not
 * export it: the triggers are raw SQL in a custom migration and that package's
 * surface is repositories. A second spelling of this string is a stream that
 * listens forever and never wakes, which is why the constant is one line under
 * one name and the tick below exists regardless.
 */
export const BOARD_CHANNEL = "atm_board";

/**
 * What the triggers put on the wire. The workspace, which is what a subscriber
 * filters on, and the card that moved, which is for the log line rather than
 * for the read — the read is the whole board either way.
 *
 * `taskId` is nullable because a run carries one and a run on a conversation
 * has none. The trigger already refuses those, so a null here would be a notice
 * from a table nobody has taught this file about yet.
 */
export const BoardNotice = Schema.Struct({
  taskId: Schema.NullOr(TaskId),
  workspaceId: WorkspaceId,
});

export interface BoardNotice extends Schema.Schema.Type<typeof BoardNotice> {}

const make = Effect.map(
  noticeStream({ channel: BOARD_CHANNEL, notice: BoardNotice }),
  (notices) => BoardNotices.of({ notices })
);

/**
 * One `LISTEN atm_board` for the whole process, multicast to every open board.
 * See `./notices` for what that buys and what it costs.
 */
export class BoardNotices extends Context.Service<
  BoardNotices,
  { readonly notices: Stream.Stream<BoardNotice> }
>()("gateway/BoardNotices") {
  static readonly layer = Layer.effect(BoardNotices, make);
}

/**
 * How often a subscriber re-reads regardless of the channel. Slow on purpose:
 * it is the repair for a notification lost to a dropped socket, not the way the
 * board is meant to arrive, and it costs nothing on the wire unless something
 * actually changed. A board that is moving is delivered by the channel and
 * never waits for this.
 */
const REFRESH_INTERVAL_MS = 30_000;

/** Which board to follow, and who is allowed to see it. */
export interface BoardSubscription {
  /** The board this reader asked for, already narrowed to their project filter. */
  readonly board: Effect.Effect<readonly BoardColumn[]>;
  readonly workspaceId: WorkspaceId;
}

/**
 * A board and its serialization together, so a snapshot is compared by what
 * would go on the wire rather than by object identity — two reads of an
 * unchanged board are two different arrays and the same board.
 */
interface Snapshot {
  readonly columns: readonly BoardColumn[];
  readonly text: string;
}

const snapshotOf = (columns: readonly BoardColumn[]): Snapshot => ({
  columns,
  text: JSON.stringify(columns),
});

/**
 * The stream a subscriber actually consumes, before its services are pinned.
 *
 * The wake-ups go through a one-slot sliding buffer. Reads run one at a time,
 * so a board being dragged about faster than the database answers would
 * otherwise queue a read per notice; sliding keeps the newest nudge and drops
 * the rest, and since every read is of the whole board, a dropped nudge costs
 * nothing.
 */
const liveBoard = (subscription: BoardSubscription) =>
  Stream.unwrap(
    Effect.gen(function* () {
      const { notices } = yield* BoardNotices;

      const mine = Stream.filter(
        notices,
        (notice) => notice.workspaceId === subscription.workspaceId
      );

      return Stream.merge(Stream.tick(REFRESH_INTERVAL_MS), mine).pipe(
        Stream.buffer({ capacity: 1, strategy: "sliding" }),
        Stream.mapEffect(() => Effect.map(subscription.board, snapshotOf)),
        Stream.changesWith((sent, next) => sent.text === next.text),
        Stream.map((snapshot) => snapshot.columns)
      );
    })
  );

/**
 * The board, now and whenever it changes, until the subscriber goes away.
 *
 * The services are read here and pinned onto the stream, because the endpoint's
 * success schema is a stream that requires none: the handler holds the request
 * context, and what it hands back has to be able to outlive the effect that
 * produced it without carrying an environment nobody is left to provide. The
 * board read is passed in already provided, for the same reason.
 *
 * Failing is not among the things this can do. A store that will not answer is
 * a defect rather than a message on a wire that has already sent a 200, and
 * unlike a run's timeline a board has no terminus: it ends when the connection
 * does.
 */
export const boardStream = (subscription: BoardSubscription) =>
  Effect.map(Effect.context<BoardNotices>(), (services) =>
    Stream.provideContext(liveBoard(subscription), services)
  );
