import type { QueryClient } from "@tanstack/react-query";
import type { BoardColumn, Task } from "@workspace/api";
import { rankBetween, type TaskId, type TaskStatus } from "@workspace/domain";
import { keys } from "@/api/keys";

/**
 * The prefix every board hangs off, read out of the key factory rather than
 * spelled again here. A board is cached once per project filter, so a move has
 * to reach all of them: the same card is on the unfiltered board and on its own
 * project's.
 */
const [TASKS_ROOT, BOARD_SEGMENT] = keys.board();
const [, LIST_SEGMENT] = keys.tasks();

/** Every board, whatever project filter it was fetched under. */
export const boardsKey = [TASKS_ROOT, BOARD_SEGMENT] as const;

/** Every flat task list, whatever filters it was fetched under. */
export const taskListsKey = [TASKS_ROOT, LIST_SEGMENT] as const;

/**
 * Where a card is going. `to` absent means it stays in its column, which is the
 * reorder gesture; `after` is the rank of the card it was dropped below, `null`
 * is the top of the column and absent is the bottom — the same three cases the
 * transition endpoint reads, so one description serves the request and the
 * optimistic write.
 */
export interface BoardMove {
  readonly after?: number | null;
  readonly taskId: TaskId;
  readonly to?: TaskStatus;
}

/** Where in a column a drop lands, from the rank it was dropped below. */
const indexFor = (tasks: readonly Task[], after: number | null | undefined) => {
  if (after === null) {
    return 0;
  }
  if (after === undefined) {
    return tasks.length;
  }
  const below = tasks.findIndex((task) => task.rank === after);
  return below === -1 ? tasks.length : below + 1;
};

/**
 * Put a card in a column at the position the drop implies, giving it the rank
 * the server will compute for it. Predicting the rank rather than leaving the
 * old one matters because the column is drawn in rank order: a card carrying a
 * stale rank would jump back to its old slot the moment anything re-sorted.
 */
const insertAt = (
  tasks: readonly Task[],
  task: Task,
  after: number | null | undefined
) => {
  const index = indexFor(tasks, after);
  const above = index === 0 ? null : (tasks[index - 1]?.rank ?? null);
  const below = tasks[index]?.rank ?? null;
  return [
    ...tasks.slice(0, index),
    { ...task, rank: rankBetween(above, below) },
    ...tasks.slice(index),
  ];
};

const taskOn = (columns: readonly BoardColumn[], taskId: TaskId) =>
  columns.flatMap((column) => column.tasks).find((task) => task.id === taskId);

/**
 * The board as it will look once the move lands.
 *
 * Pure, so the drag can be drawn before the request leaves and the same
 * function can be reasoned about without a cache in hand. A card the board does
 * not hold is left alone rather than invented — that means the cache is stale,
 * and the refetch after the write is what fixes it.
 */
export const moveOnBoard = (
  columns: readonly BoardColumn[],
  move: BoardMove
): readonly BoardColumn[] => {
  const task = taskOn(columns, move.taskId);
  if (task === undefined) {
    return columns;
  }
  const destination = move.to ?? task.status;
  const moved = { ...task, status: destination };
  return columns.map((column) => ({
    ...column,
    tasks:
      column.status === destination
        ? insertAt(
            column.tasks.filter((held) => held.id !== move.taskId),
            moved,
            move.after
          )
        : column.tasks.filter((held) => held.id !== move.taskId),
  }));
};

/**
 * Draw the move immediately and hand back what was there before.
 *
 * Dragging is the board's main gesture and a card that waits for a round trip
 * before it settles reads as a dropped drag, so the cache is written first and
 * the server's answer only confirms it. The snapshot is the rollback: on
 * failure every board goes back exactly as it was, including the ones no card
 * moved on.
 */
export const applyBoardMove = (queryClient: QueryClient, move: BoardMove) => {
  const snapshot = queryClient.getQueriesData<readonly BoardColumn[]>({
    queryKey: boardsKey,
  });
  for (const [key, columns] of snapshot) {
    if (columns !== undefined) {
      queryClient.setQueryData(key, moveOnBoard(columns, move));
    }
  }
  return snapshot;
};

/** What the boards held before a move, enough to put them back. */
export type BoardSnapshot = ReturnType<typeof applyBoardMove>;

/** Put every board back the way the snapshot found it. */
export const restoreBoards = (
  queryClient: QueryClient,
  snapshot: BoardSnapshot | undefined
) => {
  for (const [key, columns] of snapshot ?? []) {
    queryClient.setQueryData(key, columns);
  }
};

/**
 * Refresh what a write to one task can have changed: every board, every flat
 * list, and that task's own detail. The detail is invalidated exactly, because
 * its key is the prefix of the task's messages, runs, sessions and artifacts and
 * none of those are affected by where the card sits.
 */
export const settleTask = (queryClient: QueryClient, taskId: TaskId) =>
  Promise.all([
    queryClient.invalidateQueries({ queryKey: boardsKey }),
    queryClient.invalidateQueries({ queryKey: taskListsKey }),
    queryClient.invalidateQueries({ exact: true, queryKey: keys.task(taskId) }),
  ]);
