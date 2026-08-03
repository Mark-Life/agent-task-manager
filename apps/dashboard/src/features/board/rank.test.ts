import { describe, expect, test } from "bun:test";
import type { BoardColumn, Task } from "@workspace/api";
import {
  canTransition,
  nextStatuses,
  TASK_STATUSES,
  TaskId,
  type TaskStatus,
  WorkspaceId,
} from "@workspace/domain";
import { DateTime } from "effect";
import { type BoardMove, moveOnBoard } from "@/api/board-cache";
import {
  allowedTargets,
  type BoardDrag,
  planDrop,
} from "@/features/board/rank";

const when = DateTime.makeUnsafe("2026-08-02T10:00:00.000Z");

/** A task id that passes the branded uuid check, one per small number. */
const idOf = (n: number) =>
  TaskId.make(`00000000-0000-4000-8000-${String(n).padStart(12, "0")}`);

const taskOf = (n: number, status: TaskStatus, rank: number): Task => ({
  acceptance: null,
  brief: "",
  createdAt: when,
  dispatchTraceparent: null,
  id: idOf(n),
  metadata: {},
  nextSessionId: null,
  nextSessionNew: false,
  parentTaskId: null,
  parkedUntil: null,
  projectId: null,
  prUrl: null,
  rank,
  repoUrl: null,
  sandboxImage: null,
  status,
  statusChangedAt: when,
  title: `task ${n}`,
  updatedAt: when,
  workspaceId: WorkspaceId.make("workspace"),
});

const boardOf = (tasks: readonly Task[]): readonly BoardColumn[] =>
  TASK_STATUSES.map((status) => ({
    status,
    tasks: tasks.filter((task) => task.status === status),
  }));

const tasksIn = (columns: readonly BoardColumn[], status: TaskStatus) =>
  columns.find((column) => column.status === status)?.tasks ?? [];

const titlesIn = (columns: readonly BoardColumn[], status: TaskStatus) =>
  tasksIn(columns, status).map((task) => task.title);

/** Three cards in one column and one in each of the others, so every pair is reachable. */
const board = boardOf([
  taskOf(1, "backlog", 1000),
  taskOf(2, "backlog", 2000),
  taskOf(3, "backlog", 3000),
  taskOf(4, "ideas", 1000),
  taskOf(5, "in_progress", 1000),
  taskOf(6, "review", 1000),
  taskOf(7, "done", 1000),
]);

const firstIn = (status: TaskStatus) => {
  const card = tasksIn(board, status).at(0);
  if (card === undefined) {
    throw new Error(`no fixture card in ${status}`);
  }
  return card;
};

const drop = (activeId: number, over: number | TaskStatus) =>
  planDrop({
    activeId: idOf(activeId),
    columns: board,
    overId: typeof over === "number" ? idOf(over) : over,
  });

const planned = (plan: BoardDrag | null): BoardMove => {
  if (plan === null) {
    throw new Error("expected a move");
  }
  return plan;
};

/** Every pair of columns the table refuses a person, derived rather than listed. */
const illegalPairs = TASK_STATUSES.flatMap((from) =>
  TASK_STATUSES.filter(
    (to) => to !== from && !canTransition({ actorKind: "human", from, to })
  ).map((to) => ({ from, to }))
);

describe("planDrop, within a column", () => {
  test("dragging a card down lands it below the card it was dropped on", () => {
    expect(drop(1, 3)).toEqual({ after: 3000, kind: "place", taskId: idOf(1) });
  });

  test("dragging a card up lands it above the card it was dropped on", () => {
    expect(drop(3, 2)).toEqual({ after: 1000, kind: "place", taskId: idOf(3) });
  });

  test("the top of a column is a null cursor, not a rank", () => {
    expect(drop(3, 1)).toEqual({ after: null, kind: "place", taskId: idOf(3) });
  });

  test("dropping a card on itself changes nothing", () => {
    expect(drop(2, 2)).toBeNull();
  });

  test("dropping on the column itself sends the card to the bottom", () => {
    expect(drop(1, "backlog")).toEqual({
      after: 3000,
      kind: "place",
      taskId: idOf(1),
    });
  });

  test("the card already at the bottom is not sent there again", () => {
    expect(drop(3, "backlog")).toBeNull();
  });
});

describe("planDrop, across columns", () => {
  test("a legal drag becomes a transition carrying the destination", () => {
    expect(drop(2, 5)).toEqual({
      after: null,
      kind: "transition",
      taskId: idOf(2),
      to: "in_progress",
    });
  });

  test("dropping on a column lands the card at the end of it", () => {
    expect(drop(1, "in_progress")).toEqual({
      after: 1000,
      kind: "transition",
      taskId: idOf(1),
      to: "in_progress",
    });
  });

  test("an empty destination column has no card to sit below", () => {
    const lonely = boardOf([taskOf(1, "backlog", 1000)]);

    expect(
      planDrop({
        activeId: idOf(1),
        columns: lonely,
        overId: "in_progress",
      })
    ).toEqual({
      after: null,
      kind: "transition",
      taskId: idOf(1),
      to: "in_progress",
    });
  });

  test("every move the table refuses a person is refused before a request", () => {
    expect(illegalPairs.length).toBeGreaterThan(0);
    for (const pair of illegalPairs) {
      expect(
        planDrop({
          activeId: firstIn(pair.from).id,
          columns: board,
          overId: pair.to,
        })
      ).toBeNull();
    }
  });

  test("a card the board does not hold plans nothing", () => {
    expect(drop(99, 1)).toBeNull();
  });

  test("a drop over something the board does not know plans nothing", () => {
    expect(drop(1, "elsewhere" as TaskStatus)).toBeNull();
  });
});

describe("planDrop, applied to the board", () => {
  test("the planned reorder leaves the column the way the drag looked", () => {
    const moved = moveOnBoard(board, planned(drop(1, 3)));

    expect(titlesIn(moved, "backlog")).toEqual(["task 2", "task 3", "task 1"]);
  });

  test("the planned transition moves the card out of its old column", () => {
    const moved = moveOnBoard(board, planned(drop(2, 5)));

    expect(titlesIn(moved, "backlog")).toEqual(["task 1", "task 3"]);
    expect(titlesIn(moved, "in_progress")).toEqual(["task 2", "task 5"]);
  });
});

describe("allowedTargets", () => {
  test("a card may always be dropped back into its own column", () => {
    for (const status of TASK_STATUSES) {
      expect(allowedTargets(status).has(status)).toBe(true);
    }
  });

  test("the columns offered are the ones the table grants a person", () => {
    for (const from of TASK_STATUSES) {
      for (const to of nextStatuses({ actorKind: "human", from })) {
        expect(allowedTargets(from).has(to)).toBe(true);
      }
      for (const pair of illegalPairs.filter((held) => held.from === from)) {
        expect(allowedTargets(from).has(pair.to)).toBe(false);
      }
    }
  });
});
