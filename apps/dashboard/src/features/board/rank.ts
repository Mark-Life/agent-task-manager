import type { BoardColumn, Task } from "@workspace/api";
import {
  canTransition,
  nextStatuses,
  TASK_STATUSES,
  type TaskStatus,
} from "@workspace/domain";
import type { TaskMove, TaskReorder } from "@/api/tasks";

/** The board is a person's screen, so every drag is judged as a person's move. */
const ACTOR_KIND = "human";

/** A card crossing into another column, which the status machine has approved. */
export interface ColumnMove extends TaskMove {
  readonly kind: "transition";
}

/** A card moving inside its own column, which is also the dispatch queue. */
export interface ColumnPlacement extends TaskReorder {
  readonly kind: "place";
}

/** What a drop resolves to, when it resolves to anything. */
export type BoardDrag = ColumnMove | ColumnPlacement;

/** What the pointer was holding and what it was over when it came up. */
export interface Drop {
  readonly activeId: string;
  readonly columns: readonly BoardColumn[];
  readonly overId: string;
}

/** Where a drop landed: a column, and the card it resolved against if any. */
interface Target {
  readonly over: Task | null;
  readonly status: TaskStatus;
}

const cardsOn = (columns: readonly BoardColumn[]) =>
  columns.flatMap((column) => column.tasks);

const cardOn = (columns: readonly BoardColumn[], id: string) =>
  cardsOn(columns).find((task) => task.id === id);

const tasksIn = (columns: readonly BoardColumn[], status: TaskStatus) =>
  columns.find((column) => column.status === status)?.tasks ?? [];

const isStatus = (id: string): id is TaskStatus =>
  (TASK_STATUSES as readonly string[]).includes(id);

/**
 * Which column a drop is asking for. Both kinds of droppable answer here: a
 * column registers under its own status so an empty one still takes a card, and
 * a card answers with the column it sits in, which is how a drop between two
 * cards names its destination without the column itself being under the
 * pointer.
 */
const targetOf = (
  columns: readonly BoardColumn[],
  overId: string
): Target | null => {
  if (isStatus(overId)) {
    return { over: null, status: overId };
  }
  const over = cardOn(columns, overId);
  return over === undefined ? null : { over, status: over.status };
};

/**
 * Where the card lands in the destination column, counted the way a sortable
 * list counts: the index of whatever it was dropped over, in that column as it
 * is drawn. Dropping on the column rather than on a card means the end of it,
 * which is the only way a gesture can reach the bottom.
 */
const indexOf = (
  destination: readonly Task[],
  rest: readonly Task[],
  target: Target
) => {
  const { over } = target;
  return over === null
    ? rest.length
    : destination.findIndex((task) => task.id === over.id);
};

/**
 * The rank the card should sit below, which is the whole of what the server
 * needs: it takes the midpoint between that rank and the next one down, so a
 * drop writes one row and never renumbers a column. Null is the top, and a
 * column the card lands in alone is a top as much as it is an end.
 */
const rankAbove = (rest: readonly Task[], index: number) =>
  index === 0 ? null : (rest[index - 1]?.rank ?? null);

/**
 * What a drop should do, or null when it should do nothing.
 *
 * Pure, and the one place the board decides anything. The status machine is
 * asked before a request is built, so an illegal drag — a card thrown from
 * `ideas` straight to `done` — is refused here rather than round-tripped for
 * the server to refuse. A gesture that leaves the card where it already was is
 * nothing too, which is what makes a stray click on a card harmless.
 */
export const planDrop = (drop: Drop): BoardDrag | null => {
  const active = cardOn(drop.columns, drop.activeId);
  if (active === undefined) {
    return null;
  }
  const target = targetOf(drop.columns, drop.overId);
  if (target === null) {
    return null;
  }

  const destination = tasksIn(drop.columns, target.status);
  const rest = destination.filter((task) => task.id !== active.id);
  const index = indexOf(destination, rest, target);
  const after = rankAbove(rest, index);

  if (target.status === active.status) {
    const from = destination.findIndex((task) => task.id === active.id);
    return index === from ? null : { after, kind: "place", taskId: active.id };
  }

  return canTransition({
    actorKind: ACTOR_KIND,
    from: active.status,
    to: target.status,
  })
    ? { after, kind: "transition", taskId: active.id, to: target.status }
    : null;
};

/**
 * The columns a card may be dropped into from where it sits, its own included.
 *
 * Read off the same table the drop is judged by, so the board dims exactly the
 * columns it would refuse and the two answers cannot drift apart. Nothing here
 * restates the rules: {@link nextStatuses} is the table's own reader.
 */
export const allowedTargets = (from: TaskStatus): ReadonlySet<TaskStatus> =>
  new Set([from, ...nextStatuses({ actorKind: ACTOR_KIND, from })]);
