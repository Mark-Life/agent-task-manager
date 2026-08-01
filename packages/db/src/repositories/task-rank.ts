/**
 * Where a task sits in its column.
 *
 * The board is a queue as well as a display: the orchestrator spends its slots
 * on the top of *in progress*, so dragging a card up the column and telling the
 * manager agent "run this one next" are the same write, and both have to be
 * expressible as one row update rather than a renumbering.
 *
 * Both reads below run inside the caller's transaction, against the same
 * `(workspace_id, status, rank)` index the board is ordered by. Two placements
 * racing into one gap can compute the same midpoint; the column stays ordered
 * because `created_at` breaks the tie, and the next drag separates them.
 */

import {
  rankBetween,
  type TaskStatus,
  type WorkspaceId,
} from "@workspace/domain";
import { and, asc, desc, eq, gt } from "drizzle-orm";
import { Effect } from "effect";
import { task } from "../schema/task";
import { execute, type Transaction } from "./audit";

/** A placement only ever needs the neighbour's rank, never its row. */
const ONE = 1;

/** The column a rank is relative to: ranks are per status, not per workspace. */
interface Column {
  readonly status: TaskStatus;
  readonly workspaceId: WorkspaceId;
}

const inColumn = (column: Column) =>
  and(eq(task.workspaceId, column.workspaceId), eq(task.status, column.status));

/**
 * The rank that puts a task at the bottom of a column: what creating one and
 * moving one between columns both want, since neither gesture named a position.
 */
export const endOfColumn = (tx: Transaction) => (column: Column) =>
  Effect.gen(function* () {
    const last = yield* execute(
      "TaskRepo.endOfColumn",
      tx
        .select({ rank: task.rank })
        .from(task)
        .where(inColumn(column))
        .orderBy(desc(task.rank))
        .limit(ONE)
    );

    return rankBetween(last[0]?.rank ?? null, null);
  });

/**
 * The rank that lands a task directly below `after`, or at the top of the
 * column when nothing is named. The card below the target supplies the other
 * side of the midpoint, and its absence means the drop was at the bottom.
 */
export const rankAfter =
  (tx: Transaction) =>
  (options: Column & { readonly afterRank: number | null }) =>
    Effect.gen(function* () {
      if (options.afterRank === null) {
        const first = yield* execute(
          "TaskRepo.rankAfter",
          tx
            .select({ rank: task.rank })
            .from(task)
            .where(inColumn(options))
            .orderBy(asc(task.rank))
            .limit(ONE)
        );

        return rankBetween(null, first[0]?.rank ?? null);
      }

      const below = yield* execute(
        "TaskRepo.rankAfter",
        tx
          .select({ rank: task.rank })
          .from(task)
          .where(and(inColumn(options), gt(task.rank, options.afterRank)))
          .orderBy(asc(task.rank))
          .limit(ONE)
      );

      return rankBetween(options.afterRank, below[0]?.rank ?? null);
    });
