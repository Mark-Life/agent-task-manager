import { describe, expect, test } from "bun:test";
import { ACTOR_KINDS, TASK_STATUSES, type TaskStatus } from "./enums";
import {
  canCreateWithStatus,
  canDeleteTask,
  canTransition,
  creatableStatuses,
  FREE_MOVERS,
  nextStatuses,
  TASK_TRANSITIONS,
} from "./status";

/** Every ordered pair of columns, self-pairs included. */
const allMoves = (actorKind: (typeof ACTOR_KINDS)[number]) =>
  TASK_STATUSES.flatMap((from) =>
    TASK_STATUSES.map((to) => ({ actorKind, from, to }))
  );

const restricted = ACTOR_KINDS.filter(
  (actorKind) => !(FREE_MOVERS as readonly string[]).includes(actorKind)
);

describe("TASK_TRANSITIONS", () => {
  test("names no status outside the union", () => {
    const known = new Set<string>(TASK_STATUSES);
    for (const transition of TASK_TRANSITIONS) {
      expect(known.has(transition.from)).toBe(true);
      expect(known.has(transition.to)).toBe(true);
    }
  });

  test("names no actor kind outside the union, and never an empty list", () => {
    const known = new Set<string>(ACTOR_KINDS);
    for (const transition of TASK_TRANSITIONS) {
      expect(transition.actorKinds.length).toBeGreaterThan(0);
      for (const actorKind of transition.actorKinds) {
        expect(known.has(actorKind)).toBe(true);
      }
    }
  });

  test("holds one entry per edge and no self-transition", () => {
    const edges = TASK_TRANSITIONS.map(({ from, to }) => `${from}->${to}`);
    expect(new Set(edges).size).toBe(edges.length);
    for (const transition of TASK_TRANSITIONS) {
      expect(transition.from).not.toBe(transition.to);
    }
  });

  test("constrains runs only — a free mover is never listed", () => {
    for (const transition of TASK_TRANSITIONS) {
      for (const actorKind of FREE_MOVERS) {
        expect(transition.actorKinds).not.toContain(actorKind);
      }
    }
  });
});

describe("canTransition", () => {
  test("lets a free mover make every move between two columns", () => {
    for (const actorKind of FREE_MOVERS) {
      const moves = allMoves(actorKind).filter(({ from, to }) => from !== to);
      expect(moves.filter((move) => !canTransition(move))).toEqual([]);
    }
  });

  test("lets a person take the moves the old machine refused", () => {
    const reopened = [
      { from: "ideas", to: "done" },
      { from: "backlog", to: "review" },
      { from: "backlog", to: "done" },
      { from: "done", to: "ideas" },
      { from: "review", to: "ideas" },
    ] as const;
    for (const { from, to } of reopened) {
      for (const actorKind of FREE_MOVERS) {
        expect(canTransition({ actorKind, from, to })).toBe(true);
      }
    }
  });

  test("the manager has every move a person has", () => {
    for (const from of TASK_STATUSES) {
      for (const to of TASK_STATUSES) {
        expect(canTransition({ actorKind: "manager", from, to })).toBe(
          canTransition({ actorKind: "human", from, to })
        );
      }
    }
  });

  test("refuses a move to the column the card is already in, whoever asks", () => {
    for (const actorKind of ACTOR_KINDS) {
      for (const status of TASK_STATUSES) {
        expect(canTransition({ actorKind, from: status, to: status })).toBe(
          false
        );
      }
    }
  });

  test("rejects an actor kind without permission on an otherwise legal edge", () => {
    expect(
      canTransition({
        actorKind: "orchestrator",
        from: "backlog",
        to: "in_progress",
      })
    ).toBe(false);
    expect(
      canTransition({
        actorKind: "worker_run",
        from: "in_progress",
        to: "backlog",
      })
    ).toBe(false);
  });

  test("lets a worker and the orchestrator close a run, and nothing else", () => {
    for (const actorKind of ["worker_run", "orchestrator"] as const) {
      expect(
        canTransition({ actorKind, from: "in_progress", to: "review" })
      ).toBe(true);
      expect(nextStatuses({ actorKind, from: "in_progress" })).toEqual([
        "review",
      ]);
      expect(allMoves(actorKind).filter(canTransition)).toEqual([
        { actorKind, from: "in_progress", to: "review" },
      ]);
    }
  });

  test("no run of any kind reaches done", () => {
    for (const actorKind of restricted) {
      for (const from of TASK_STATUSES) {
        expect(canTransition({ actorKind, from, to: "done" })).toBe(false);
      }
    }
  });

  test("system performs no transitions at all", () => {
    expect(allMoves("system").filter(canTransition)).toEqual([]);
  });
});

describe("creatableStatuses", () => {
  test("lets a free mover and the seed script file into any column", () => {
    for (const actorKind of [...FREE_MOVERS, "system"] as const) {
      expect(new Set(creatableStatuses(actorKind))).toEqual(
        new Set<TaskStatus>(TASK_STATUSES)
      );
    }
  });

  test("keeps a run from filing into done or in_progress", () => {
    for (const actorKind of ["worker_run", "orchestrator"] as const) {
      for (const status of ["done", "in_progress"] as const) {
        expect(canCreateWithStatus({ actorKind, status })).toBe(false);
      }
    }
  });

  test("holds one entry per column", () => {
    for (const actorKind of ACTOR_KINDS) {
      const allowed = creatableStatuses(actorKind);
      expect(new Set(allowed).size).toBe(allowed.length);
    }
  });

  test("lets anybody file an idea, since nothing transitions into that column", () => {
    for (const actorKind of ACTOR_KINDS) {
      expect(canCreateWithStatus({ actorKind, status: "ideas" })).toBe(true);
    }
  });
});

describe("nextStatuses", () => {
  test("offers a free mover every column but the one the card is in", () => {
    for (const actorKind of FREE_MOVERS) {
      for (const from of TASK_STATUSES) {
        expect(new Set(nextStatuses({ actorKind, from }))).toEqual(
          new Set(TASK_STATUSES.filter((status) => status !== from))
        );
      }
    }
  });

  test("agrees with canTransition for every actor kind and status", () => {
    for (const actorKind of ACTOR_KINDS) {
      for (const from of TASK_STATUSES) {
        const allowed = new Set(nextStatuses({ actorKind, from }));
        for (const to of TASK_STATUSES) {
          expect(allowed.has(to)).toBe(canTransition({ actorKind, from, to }));
        }
      }
    }
  });
});

describe("canDeleteTask", () => {
  test("is the free movers, and nobody else", () => {
    for (const actorKind of FREE_MOVERS) {
      expect(canDeleteTask({ actorKind })).toBe(true);
    }
    for (const actorKind of restricted) {
      expect(canDeleteTask({ actorKind })).toBe(false);
    }
  });

  test("keeps a worker run from erasing the task it was dispatched for", () => {
    expect(canDeleteTask({ actorKind: "worker_run" })).toBe(false);
  });
});
