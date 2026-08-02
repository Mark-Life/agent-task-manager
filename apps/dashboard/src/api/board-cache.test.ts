import { describe, expect, test } from "bun:test";
import type { BoardColumn, Task } from "@workspace/api";
import {
  RANK_STEP,
  TASK_STATUSES,
  TaskId,
  type TaskStatus,
  WorkspaceId,
} from "@workspace/domain";
import { DateTime } from "effect";
import { moveOnBoard } from "@/api/board-cache";

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

const column = (columns: readonly BoardColumn[], status: TaskStatus) =>
  columns.find((held) => held.status === status);

const titlesIn = (columns: readonly BoardColumn[], status: TaskStatus) =>
  column(columns, status)?.tasks.map((task) => task.title) ?? [];

const backlog = [
  taskOf(1, "backlog", 1000),
  taskOf(2, "backlog", 2000),
  taskOf(3, "backlog", 3000),
];

describe("moveOnBoard", () => {
  test("a null cursor lands the card on top of the destination", () => {
    const moved = moveOnBoard(boardOf(backlog), {
      after: null,
      taskId: idOf(3),
      to: "in_progress",
    });

    expect(titlesIn(moved, "in_progress")).toEqual(["task 3"]);
    expect(titlesIn(moved, "backlog")).toEqual(["task 1", "task 2"]);
  });

  test("an absent cursor lands the card at the bottom", () => {
    const moved = moveOnBoard(boardOf(backlog), {
      taskId: idOf(1),
      to: "backlog",
    });

    expect(titlesIn(moved, "backlog")).toEqual(["task 2", "task 3", "task 1"]);
  });

  test("a rank lands the card below the card holding it", () => {
    const moved = moveOnBoard(boardOf(backlog), {
      after: 1000,
      taskId: idOf(3),
      to: "backlog",
    });

    expect(titlesIn(moved, "backlog")).toEqual(["task 1", "task 3", "task 2"]);
    expect(column(moved, "backlog")?.tasks[1]?.rank).toBe(1500);
  });

  test("a card dropped at the top of an empty column keeps a usable rank", () => {
    const moved = moveOnBoard(boardOf(backlog), {
      after: null,
      taskId: idOf(2),
      to: "review",
    });

    expect(column(moved, "review")?.tasks[0]?.rank).toBe(0);
  });

  test("a card appended to a column ranks below the last one", () => {
    const moved = moveOnBoard(boardOf(backlog), {
      taskId: idOf(1),
      to: "backlog",
    });

    expect(column(moved, "backlog")?.tasks[2]?.rank).toBe(3000 + RANK_STEP);
  });

  test("omitting the destination keeps the card in its own column", () => {
    const moved = moveOnBoard(boardOf(backlog), {
      after: null,
      taskId: idOf(3),
    });

    expect(titlesIn(moved, "backlog")).toEqual(["task 3", "task 1", "task 2"]);
  });

  test("a card the board does not hold leaves it untouched", () => {
    const board = boardOf(backlog);

    expect(
      moveOnBoard(board, { after: null, taskId: idOf(9), to: "done" })
    ).toBe(board);
  });
});
