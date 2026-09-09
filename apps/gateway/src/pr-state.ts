/**
 * Keeping the pull request state on a card current, without a timer and without
 * hammering GitHub.
 *
 * The state is drawn from the task row, so a board renders from this database
 * with no network in the path. This is what puts a newer answer in that row, and
 * every rule it follows is about *not* asking:
 *
 * - **On view, never on a schedule.** A board read is the signal that somebody
 *   is looking, and it is the only thing that queues a refresh. A card in a
 *   column nobody has open is never asked about, however stale it gets, because
 *   the answer would be read by nobody.
 * - **At most once per {@link REFRESH_TTL_MS} per card.** The dashboard polls
 *   the board every ten seconds; without a floor that would be six lookups a
 *   minute per pull request.
 * - **Never once merged or closed.** Those are where a pull request stops, so
 *   the row keeps its answer and the card leaves the loop for good. The cost of
 *   that rule is a closed request somebody later reopens, which keeps drawing
 *   red — the state stays wrong until the card's `pr_url` is written again.
 * - **Conditionally.** The `ETag` from the last answer goes back as
 *   `If-None-Match`, and GitHub charges nothing for the `304` that usually
 *   comes back. `.docs/pull-request-state.md` has the arithmetic and what it
 *   was weighed against.
 *
 * The refresh runs behind the request rather than inside it. A board read that
 * waited for GitHub would be a board that renders at GitHub's latency and fails
 * when GitHub is down, which is the whole thing the cached column exists to
 * avoid — so `observe` offers to a queue and returns, and the answer lands on a
 * later poll.
 */

import { TaskRepo } from "@workspace/db";
import {
  isTerminalPrState,
  type PrState,
  parsePrUrl,
  type Task,
  type TaskId,
  type WorkspaceId,
} from "@workspace/domain";
import { readPrState } from "@workspace/sandbox";
import { Context, DateTime, Effect, Layer, Queue } from "effect";

/**
 * How old a cached state may get while somebody is watching the column it is
 * in. Two minutes against a board that polls every ten seconds: a merge shows
 * up inside the time it takes to switch windows and come back, and a card costs
 * thirty lookups an hour at the very most — nearly all of them `304`s that GitHub
 * does not bill.
 */
export const REFRESH_TTL_MS = 120_000;

/**
 * How many lookups are in flight at once. GitHub's secondary limits allow far
 * more; what this bounds is the gateway's own sockets and the burst a freshly
 * opened board with thirty pull requests on it produces.
 */
const REFRESH_CONCURRENCY = 4;

/**
 * How many cards may be waiting to be asked about. A dropping queue rather than
 * a growing one: what a full queue discards is a *request to check*, and the
 * next board poll — ten seconds later — makes the same request again. Sized
 * well past a board a person can see at once, so the drop only ever happens
 * when GitHub has stopped answering.
 */
const REFRESH_QUEUE_CAPACITY = 256;

/**
 * When the freshness table is pruned back. It holds one small entry per card
 * with a live pull request that somebody has looked at since this process
 * started, which is a bounded set in practice; the cap is here so that a very
 * long-lived gateway on a very large board still has a ceiling.
 */
const CHECKED_TABLE_CAP = 4096;

/** One card to ask GitHub about. */
interface Pending {
  readonly taskId: TaskId;
  readonly workspaceId: WorkspaceId;
}

/**
 * What this process remembers about a card between refreshes, and deliberately
 * does not store.
 *
 * `checkedAt` is when GitHub was last *asked*, which is not what the row's
 * `pr_state_at` records — the row is written only when the state actually
 * changed, because every write to `task` carries an audit row and "checked,
 * still open" thirty times an hour is not a thing that happened to the card.
 *
 * `etag` is the newest validator seen, which the row also cannot always hold:
 * editing a pull request's title changes its `ETag` without changing its state,
 * so the row's copy — written with the last state change — can be older than
 * this one. Keeping both is what makes the next request a `304` rather than a
 * `200` nobody needed.
 */
interface Checked {
  readonly checkedAt: number;
  readonly etag: string | null;
}

/**
 * Whether this card is worth asking GitHub about at all, before anything is
 * read or sent.
 *
 * Answered off the task the board read already produced, so a column of cards
 * with no pull requests costs nothing but this predicate.
 *
 * Exported for the test that holds it to the three rules it encodes; the
 * service below is the only caller.
 */
export const isRefreshable = (task: Task) =>
  task.prUrl !== null &&
  parsePrUrl(task.prUrl) !== null &&
  !(task.prState !== null && isTerminalPrState(task.prState));

/**
 * How fresh the stored answer is, taking the better of what this process
 * remembers asking and what the row itself claims.
 *
 * The row's stamp is what covers a restart: a gateway that came up a second ago
 * remembers nothing, and without this it would re-ask about every card on the
 * first board read. Those requests would all be cheap and none of them would be
 * useful.
 *
 * Exported for the same reason as {@link isRefreshable}.
 */
export const freshestAt = (options: {
  readonly checked: Checked | undefined;
  readonly task: Task;
}) =>
  Math.max(
    options.checked === undefined ? 0 : options.checked.checkedAt,
    options.task.prStateAt === null
      ? 0
      : DateTime.toEpochMillis(options.task.prStateAt)
  );

/** What a refresh needs and could not read off the task. */
interface Resolved {
  readonly etag: string | null;
  readonly prState: PrState | null;
  readonly prUrl: string;
}

const make = Effect.gen(function* () {
  const tasks = yield* TaskRepo;
  const queue = yield* Queue.dropping<Pending>(REFRESH_QUEUE_CAPACITY);

  /**
   * When each card was last asked about, and with which validator. A plain map
   * rather than a `Ref`: every write happens on the single drain fiber, and
   * `observe` only reads.
   */
  const checked = new Map<TaskId, Checked>();

  /**
   * Drops the entries that have gone cold. Everything older than the TTL would
   * be re-asked on its next appearance anyway, so forgetting it costs one
   * unconditional request and nothing else.
   */
  const prune = (now: number) => {
    if (checked.size <= CHECKED_TABLE_CAP) {
      return;
    }
    for (const [taskId, entry] of checked) {
      if (now - entry.checkedAt >= REFRESH_TTL_MS) {
        checked.delete(taskId);
      }
    }
  };

  /**
   * The URL, the stored state and the validator to send, read under the row
   * rather than off the board's copy.
   *
   * The board's read may be seconds old and the ETag is not on it at all — it
   * is storage, and `decodeTask` drops it — so the refresh starts from the row.
   * A card deleted or retargeted in between answers null and is dropped.
   */
  const resolve = (pending: Pending) =>
    Effect.gen(function* () {
      const cache = yield* tasks.prCache({
        id: pending.taskId,
        workspaceId: pending.workspaceId,
      });
      if (cache === null || cache.prUrl === null) {
        return null;
      }
      if (cache.prState !== null && isTerminalPrState(cache.prState)) {
        return null;
      }
      return {
        etag: checked.get(pending.taskId)?.etag ?? cache.prEtag,
        prState: cache.prState,
        prUrl: cache.prUrl,
      } satisfies Resolved;
    });

  /**
   * One card: read the row, ask GitHub, write back only if the answer is news.
   *
   * The card is stamped as checked before the request goes out, so a board poll
   * arriving while this one is in flight does not queue a second lookup for it.
   */
  const refresh = (pending: Pending) =>
    Effect.gen(function* () {
      const startedAt = yield* DateTime.now;
      checked.set(pending.taskId, {
        checkedAt: DateTime.toEpochMillis(startedAt),
        etag: checked.get(pending.taskId)?.etag ?? null,
      });

      const resolved = yield* resolve(pending);
      if (resolved === null) {
        return;
      }

      const answer = yield* readPrState({
        etag: resolved.etag,
        prUrl: resolved.prUrl,
      });
      if (answer._tag !== "state") {
        return;
      }

      checked.set(pending.taskId, {
        checkedAt: DateTime.toEpochMillis(startedAt),
        etag: answer.etag,
      });
      if (answer.state === resolved.prState) {
        return;
      }

      yield* tasks.recordPrState({
        etag: answer.etag,
        id: pending.taskId,
        prUrl: resolved.prUrl,
        state: answer.state,
        workspaceId: pending.workspaceId,
      });
    }).pipe(
      // A refresh that fails is a card that keeps the state it had. The store
      // being unreachable is the gateway's problem and is already being
      // reported by every request that needs it; this fiber must not be the one
      // that dies of it, because it never comes back.
      Effect.catchCause((cause) =>
        Effect.logInfo("pull request state refresh failed", {
          reason: String(cause),
          taskId: pending.taskId,
        })
      ),
      Effect.withSpan("PrStates.refresh")
    );

  /**
   * Takes whatever has piled up and asks about each card once.
   *
   * The batch is deduplicated because a board poll offers every stale card and
   * two polls can land before the first batch is drained — without this, the
   * same pull request would be asked about twice in one round.
   */
  const drain = Effect.gen(function* () {
    const batch = yield* Queue.takeAll(queue);
    const now = yield* DateTime.now;
    prune(DateTime.toEpochMillis(now));

    const unique = new Map<TaskId, Pending>();
    for (const pending of batch) {
      unique.set(pending.taskId, pending);
    }

    yield* Effect.forEach([...unique.values()], refresh, {
      concurrency: REFRESH_CONCURRENCY,
      discard: true,
    });
  });

  yield* Effect.forkScoped(Effect.forever(drain));

  /**
   * Queue whatever in this board read has gone stale.
   *
   * Never fails and never waits: the caller is a request handler that has
   * already produced its answer, and a full queue drops the request to check
   * rather than pushing back on the read.
   */
  const observe = (input: {
    readonly tasks: readonly Task[];
    readonly workspaceId: WorkspaceId;
  }) =>
    Effect.gen(function* () {
      const now = DateTime.toEpochMillis(yield* DateTime.now);
      const due = input.tasks.filter(
        (task) =>
          isRefreshable(task) &&
          now - freshestAt({ checked: checked.get(task.id), task }) >=
            REFRESH_TTL_MS
      );

      yield* Effect.forEach(
        due,
        (task) =>
          Queue.offer(queue, {
            taskId: task.id,
            workspaceId: input.workspaceId,
          }),
        { discard: true }
      );
    });

  return PrStates.of({ observe });
});

/**
 * The pull request states a board read has just shown somebody, and the promise
 * that a newer answer will be in the row before long.
 *
 * Build it over the layer that provides the store and the actor: it writes task
 * rows, and the write is the gateway's own — nobody asked for it, it is the
 * consequence of a card being looked at.
 */
export class PrStates extends Context.Service<
  PrStates,
  {
    readonly observe: (input: {
      readonly tasks: readonly Task[];
      readonly workspaceId: WorkspaceId;
    }) => Effect.Effect<void>;
  }
>()("gateway/PrStates") {
  static readonly layer = Layer.effect(PrStates, make);
}
