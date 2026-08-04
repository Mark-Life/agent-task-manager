/**
 * What the compiler cannot say about the shared write path.
 *
 * That a mutation records itself is a type error when it does not, so it needs
 * no test. What the diff *says* about a mutation is a runtime decision, and it
 * is the part someone later trusts: a field logged as changed when it did not
 * change sends a reader looking for a change that never happened.
 */

import { describe, expect, test } from "bun:test";
import { TaskId, WorkspaceId } from "@workspace/domain";
import { Effect, Exit } from "effect";
import { auditCreate, audited, changesOf, writableValues } from "./audit";

const WORKSPACE_ID = WorkspaceId.make("PBSaJDPvV9DsknwR4T0YoZs5Bp8QLqZM");
const TASK_UUID = TaskId.make("0198f0c2-0f2e-7000-8000-000000000001");

describe("changesOf", () => {
  test("records a field the patch actually moved", () => {
    expect(
      changesOf({ after: { title: "after" }, before: { title: "before" } })
    ).toEqual({ title: { from: "before", to: "after" } });
  });

  test("leaves out a patch that repeats the stored value", () => {
    expect(
      changesOf({ after: { title: "same" }, before: { title: "same" } })
    ).toEqual({});
  });

  test("leaves out a field the patch did not mention", () => {
    expect(
      changesOf({
        after: { brief: undefined, title: "after" },
        before: { brief: "kept", title: "before" },
      })
    ).toEqual({ title: { from: "before", to: "after" } });
  });

  test("reads a cleared column as a change to null", () => {
    expect(
      changesOf({ after: { prUrl: null }, before: { prUrl: "https://pr" } })
    ).toEqual({ prUrl: { from: "https://pr", to: null } });
  });

  test("reads a column that was already null as unchanged", () => {
    expect(
      changesOf({ after: { prUrl: null }, before: { prUrl: null } })
    ).toEqual({});
  });

  test("stores an instant as the ISO string jsonb can hold", () => {
    expect(
      changesOf({
        after: { parkedUntil: new Date("2026-02-01T00:00:00.000Z") },
        before: { parkedUntil: new Date("2026-01-01T00:00:00.000Z") },
      })
    ).toEqual({
      parkedUntil: {
        from: "2026-01-01T00:00:00.000Z",
        to: "2026-02-01T00:00:00.000Z",
      },
    });
  });

  test("compares a jsonb column by its content, not by identity", () => {
    expect(
      changesOf({
        after: { metadata: { articleUrl: "https://example.com" } },
        before: { metadata: { articleUrl: "https://example.com" } },
      })
    ).toEqual({});
  });

  test("sees a field the row never had", () => {
    expect(changesOf({ after: { title: "new" }, before: {} })).toEqual({
      title: { from: null, to: "new" },
    });
  });
});

/**
 * The other runtime decision on the write path. A patch with nothing in it
 * typechecks — every field of a patch is optional — and the driver throws where
 * it builds an `UPDATE` with no assignments, outside every Effect boundary, so
 * a caller would get a dead fiber where the package promises a typed failure.
 */
describe("writableValues", () => {
  test("refuses a patch with no field to write", () => {
    const exit = Effect.runSyncExit(
      writableValues({ entity: "task", values: {} })
    );
    expect(Exit.isFailure(exit)).toBe(true);
  });

  test("refuses a patch whose every field is absent", () => {
    const exit = Effect.runSyncExit(
      writableValues({ entity: "task", values: { title: undefined } })
    );
    expect(Exit.isFailure(exit)).toBe(true);
  });

  test("passes a patch that clears a column, which is a change like any other", () => {
    expect(
      Effect.runSync(
        writableValues({ entity: "task", values: { prUrl: null } })
      )
    ).toEqual({ prUrl: null });
  });
});

describe("audited", () => {
  test("carries every entry a mutation described itself with", () => {
    const subject = {
      entityId: TASK_UUID,
      entityType: "task",
      taskId: null,
      workspaceId: WORKSPACE_ID,
    } as const;

    expect(audited("value", auditCreate(subject)).entries).toEqual([
      {
        action: "create",
        changes: {},
        entityId: TASK_UUID,
        entityType: "task",
        fromStatus: null,
        taskId: null,
        toStatus: null,
        workspaceId: WORKSPACE_ID,
      },
    ]);
  });
});
