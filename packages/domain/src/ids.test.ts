import { describe, expect, test } from "bun:test";
import { Schema } from "effect";
import {
  newAgentSessionId,
  newRunId,
  newTaskId,
  type RunId,
  TaskId,
  type UserId,
  type WorkspaceId,
} from "./ids";

describe("minted ids", () => {
  test("mints a value the id's own schema accepts", () => {
    const id = newTaskId();
    expect(Schema.decodeUnknownSync(TaskId)(id)).toBe(id);
  });

  test("sorts by creation, so an id is a stable tiebreaker on created_at", () => {
    const first = newTaskId();
    const second = newTaskId();
    expect([second, first].sort()).toEqual([first, second]);
  });

  test("rejects a value that is not a uuid", () => {
    expect(() => Schema.decodeUnknownSync(TaskId)("not-a-uuid")).toThrow();
  });
});

describe("branding", () => {
  test("a RunId cannot stand in for a TaskId", () => {
    const runId: RunId = newRunId();
    // @ts-expect-error a run's id must never be accepted where a task's is wanted
    const taskId: TaskId = runId;
    expect(taskId).toBe(runId as unknown as TaskId);
  });

  test("an AgentSessionId cannot stand in for a RunId", () => {
    const sessionId = newAgentSessionId();
    // @ts-expect-error a session's id must never be accepted where a run's is wanted
    const runId: RunId = sessionId;
    expect(runId).toBe(sessionId as unknown as RunId);
  });

  test("a UserId cannot stand in for a WorkspaceId", () => {
    const userId = "8f6ba3cc0d2a4a0f9b1f7e2c5d3a6b41" as UserId;
    // @ts-expect-error the two are both Better Auth text ids and are not interchangeable
    const workspaceId: WorkspaceId = userId;
    expect(workspaceId).toBe(userId as unknown as WorkspaceId);
  });
});
