import { describe, expect, test } from "bun:test";
import { Schema } from "effect";
import { RUN_EVENT_KINDS } from "./enums";
import { newRunCommandId, newRunEventId, newRunId, newTaskId } from "./ids";
import { splitPayload } from "./primitives";
import { RunEvent, RunEventPayload } from "./run-event";

const now = new Date("2026-08-01T09:00:00.000Z");

const row: typeof RunEvent.Encoded = {
  createdAt: now,
  id: newRunEventId(),
  occurredAt: new Date("2026-08-01T08:59:59.100Z"),
  payload: {
    callId: "call-7",
    inputChars: 214,
    kind: "tool_call",
    summary: "read src/index.ts",
    toolName: "Read",
  },
  runId: newRunId(),
  seq: 0,
  taskId: newTaskId(),
  workspaceId: "8f6ba3cc0d2a4a0f9b1f7e2c5d3a6b41",
};

describe("RunEventPayload", () => {
  test("covers every run event kind", () => {
    expect(new Set(RunEventPayload.discriminants)).toEqual(
      new Set(RUN_EVENT_KINDS)
    );
  });

  test("rejects a payload whose fields belong to another kind", () => {
    expect(() =>
      Schema.decodeUnknownSync(RunEventPayload)({
        chars: 10,
        kind: "tool_call",
      })
    ).toThrow();
  });

  test("keeps economics nullable, so a degraded run reports no number rather than zero", () => {
    const decoded = Schema.decodeUnknownSync(RunEventPayload)({
      costUsd: null,
      durationMs: 1200,
      kind: "finished",
      outcome: "interrupted",
      totalTokens: 0,
      turns: 0,
    });
    expect(RunEventPayload.guards.finished(decoded)).toBe(true);
  });
});

describe("RunEvent", () => {
  test("round-trips a row without losing or inventing a field", () => {
    const decoded = Schema.decodeUnknownSync(RunEvent)(row);
    expect(Schema.encodeSync(RunEvent)(decoded)).toEqual(row);
  });

  test("splits into the kind column and a blob that does not repeat the tag", () => {
    const decoded = Schema.decodeUnknownSync(RunEvent)(row);
    const split = splitPayload(decoded.payload);
    expect(split.kind).toBe("tool_call");
    expect(split.payload).not.toHaveProperty("kind");
  });

  test("rejects an event whose stop command id is not a uuid", () => {
    expect(() =>
      Schema.decodeUnknownSync(RunEventPayload)({
        commandId: "not-a-uuid",
        kind: "stopped",
        requestedByKind: "human",
      })
    ).toThrow();
    expect(
      Schema.decodeUnknownSync(RunEventPayload)({
        commandId: newRunCommandId(),
        kind: "stopped",
        requestedByKind: "human",
      })
    ).toHaveProperty("kind", "stopped");
  });
});
