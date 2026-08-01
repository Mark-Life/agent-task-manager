import { describe, expect, test } from "bun:test";
import { ACTOR_KINDS, TASK_STATUSES, type TaskStatus } from "./enums";
import {
  canCreateWithStatus,
  canTransition,
  creatableStatuses,
  nextStatuses,
  TASK_TRANSITIONS,
} from "./status";

const froms = new Set(TASK_TRANSITIONS.map((transition) => transition.from));
const tos = new Set(TASK_TRANSITIONS.map((transition) => transition.to));

describe("TASK_TRANSITIONS", () => {
  test("covers the status union: every status has a way out and a way in", () => {
    for (const status of TASK_STATUSES) {
      expect({
        hasIn: tos.has(status),
        hasOut: froms.has(status),
        status,
      }).toEqual({ hasIn: true, hasOut: true, status });
    }
  });

  test("names no status outside the union, so nothing is unreachable in either direction", () => {
    const known = new Set<string>(TASK_STATUSES);
    for (const status of [...froms, ...tos]) {
      expect(known.has(status)).toBe(true);
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
});

describe("canTransition", () => {
  test("allows the dispatch trigger for a human", () => {
    expect(
      canTransition({ actorKind: "human", from: "backlog", to: "in_progress" })
    ).toBe(true);
  });

  test("rejects an edge that is not in the table", () => {
    expect(
      canTransition({ actorKind: "human", from: "ideas", to: "done" })
    ).toBe(false);
    expect(
      canTransition({ actorKind: "human", from: "review", to: "ideas" })
    ).toBe(false);
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
    }
  });

  test("no run of any kind reaches done", () => {
    for (const actorKind of ["worker_run", "orchestrator"] as const) {
      for (const from of TASK_STATUSES) {
        expect(canTransition({ actorKind, from, to: "done" })).toBe(false);
      }
    }
  });

  test("the manager has every move a person has", () => {
    for (const { actorKinds, from, to } of TASK_TRANSITIONS) {
      if (actorKinds.includes("human")) {
        expect(canTransition({ actorKind: "manager", from, to })).toBe(true);
      }
    }
  });

  test("a worker run may only end its own work", () => {
    const moves = TASK_STATUSES.flatMap((from) =>
      TASK_STATUSES.map((to) => ({
        actorKind: "worker_run" as const,
        from,
        to,
      }))
    );
    expect(moves.filter(canTransition)).toEqual([
      { actorKind: "worker_run", from: "in_progress", to: "review" },
    ]);
  });

  test("system performs no transitions at all", () => {
    const moves = TASK_STATUSES.flatMap((from) =>
      TASK_STATUSES.map((to) => ({ actorKind: "system" as const, from, to }))
    );
    expect(moves.filter(canTransition)).toEqual([]);
  });
});

describe("creatableStatuses", () => {
  test("lets a human and the seed script file into any column", () => {
    for (const actorKind of ["human", "system"] as const) {
      expect(new Set(creatableStatuses(actorKind))).toEqual(
        new Set(TASK_STATUSES)
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

  test("lets the manager file into any column, as a person can", () => {
    expect(new Set(creatableStatuses("manager"))).toEqual(
      new Set<TaskStatus>(TASK_STATUSES)
    );
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
  test("returns only statuses the table allows this actor", () => {
    expect(
      new Set(nextStatuses({ actorKind: "worker_run", from: "in_progress" }))
    ).toEqual(new Set<TaskStatus>(["review"]));
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
