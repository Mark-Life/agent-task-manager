/**
 * What the conformance test cannot say: that decoding is real validation.
 *
 * The types line up whether or not anything is checked at runtime — a cast
 * would satisfy them too — so these are the cases that separate the two. A
 * status the machine has never heard of, a `jsonb` blob that does not hold what
 * the column claims, and a NULL in a column the function-form refinement was
 * there to protect.
 */

import { describe, expect, test } from "bun:test";
import { CostUsd } from "@workspace/domain";
import { DateTime, Effect } from "effect";
import { decodeProject } from "./project";
import { decodeRun } from "./run";
import { decodeRunCommand } from "./run-command";
import { decodeRunEvent } from "./run-event";
import { decodeTask } from "./task";

const WORKSPACE_ID = "PBSaJDPvV9DsknwR4T0YoZs5Bp8QLqZM";
const TASK_UUID = "0198f0c2-0f2e-7000-8000-000000000001";
const RUN_UUID = "0198f0c2-0f2e-7000-8000-000000000002";
const EVENT_UUID = "0198f0c2-0f2e-7000-8000-000000000003";
const SESSION_UUID = "0198f0c2-0f2e-7000-8000-000000000004";
const COMMAND_UUID = "0198f0c2-0f2e-7000-8000-000000000005";
const AT = new Date("2026-01-01T00:00:00.000Z");

/** A `task` row exactly as `pg` hands it back: `Date` instants, plain strings, NULLs. */
const taskRow = {
  acceptance: null,
  brief: "",
  createdAt: AT,
  dispatchTraceparent: null,
  id: TASK_UUID,
  metadata: { articleUrl: "https://example.com" },
  nextSessionId: null,
  nextSessionNew: false,
  parentTaskId: null,
  parkedUntil: null,
  projectId: null,
  prUrl: null,
  rank: 0,
  repoUrl: null,
  sandboxImage: null,
  status: "backlog",
  statusChangedAt: AT,
  title: "Ship the thing",
  updatedAt: AT,
  workspaceId: WORKSPACE_ID,
};

const runRow = {
  agentHomePath: null,
  agentSessionId: SESSION_UUID,
  attempt: 1,
  branch: null,
  containerId: null,
  costUsd: "0.000001",
  createdAt: AT,
  durationMs: null,
  errorClass: null,
  errorMessage: null,
  exitCode: null,
  finishedAt: null,
  id: RUN_UUID,
  model: null,
  outcome: null,
  provider: "claude",
  sandboxImage: null,
  startedAt: null,
  status: "running",
  taskId: TASK_UUID,
  totalTokens: null,
  traceId: null,
  trigger: "status_change",
  turns: null,
  updatedAt: AT,
  workspaceId: WORKSPACE_ID,
};

const runEventRow = {
  createdAt: AT,
  id: EVENT_UUID,
  kind: "usage",
  occurredAt: AT,
  payload: {
    costUsd: "0.42",
    inputTokens: 1200,
    outputTokens: 340,
    rateLimitPct: null,
    turns: 3,
  },
  runId: RUN_UUID,
  seq: 0,
  taskId: TASK_UUID,
  workspaceId: WORKSPACE_ID,
};

const runCommandRow = {
  actorKind: "manager",
  actorRunId: null,
  actorSessionId: null,
  actorUserId: "wJ8kQ2LmR5tV7yX0zB3cD6fG9hJ1kL4n",
  consumedAt: null,
  createdAt: AT,
  id: COMMAND_UUID,
  kind: "start_session",
  payload: { trigger: "research" },
  rejectedReason: null,
  runId: null,
  status: "pending",
  taskId: TASK_UUID,
  traceparent: null,
  updatedAt: AT,
  workspaceId: WORKSPACE_ID,
};

const decode = <A, E>(effect: Effect.Effect<A, E>) => Effect.runSync(effect);

const failsToDecode = <A, E>(effect: Effect.Effect<A, E>) =>
  expect(() => Effect.runSync(effect)).toThrow();

describe("task", () => {
  test("reads a timestamptz column as a zone-aware instant", () => {
    expect(DateTime.toDate(decode(decodeTask(taskRow)).createdAt)).toEqual(AT);
  });

  test("keeps a NULL in a nullable column, which the bare-schema refinement would have dropped", () => {
    expect(decode(decodeTask(taskRow)).parkedUntil).toBeNull();
  });

  test("rejects a status the machine has never heard of", () => {
    failsToDecode(decodeTask({ ...taskRow, status: "blocked" }));
  });

  test("rejects a metadata blob that is not an object", () => {
    failsToDecode(decodeTask({ ...taskRow, metadata: "articleUrl" }));
  });

  test("rejects a metadata blob holding a value JSON cannot carry", () => {
    failsToDecode(decodeTask({ ...taskRow, metadata: { seenAt: new Date() } }));
  });

  test("rejects an empty title", () => {
    failsToDecode(decodeTask({ ...taskRow, title: "" }));
  });
});

describe("project", () => {
  test("rejects a row missing a column entirely", () => {
    failsToDecode(decodeProject({ id: TASK_UUID, name: "orphan" }));
  });
});

describe("run", () => {
  test("keeps a cost exact, as the string the numeric column holds", () => {
    expect(decode(decodeRun(runRow)).costUsd).toBe(CostUsd.make("0.000001"));
  });

  test("leaves the economics null on a run that has produced no numbers", () => {
    expect(decode(decodeRun(runRow)).turns).toBeNull();
  });

  test("rejects an unknown run status", () => {
    failsToDecode(decodeRun({ ...runRow, status: "paused" }));
  });

  test("rejects a cost that is not a decimal", () => {
    failsToDecode(decodeRun({ ...runRow, costUsd: "about a dollar" }));
  });

  test("rejects a negative turn count", () => {
    failsToDecode(decodeRun({ ...runRow, turns: -1 }));
  });
});

describe("run event", () => {
  test("rejoins the kind column with its blob as one tagged payload", () => {
    const event = decode(decodeRunEvent(runEventRow));
    expect(event.payload.kind).toBe("usage");
    expect(event).not.toHaveProperty("kind");
  });

  test("rejects a malformed payload for a kind the column names", () => {
    failsToDecode(
      decodeRunEvent({
        ...runEventRow,
        payload: { ...runEventRow.payload, turns: "several" },
      })
    );
  });

  test("rejects a payload missing a field its kind requires", () => {
    failsToDecode(decodeRunEvent({ ...runEventRow, payload: {} }));
  });

  test("rejects a payload that is not an object at all", () => {
    failsToDecode(decodeRunEvent({ ...runEventRow, payload: "42" }));
  });

  test("rejects a kind outside the union", () => {
    failsToDecode(decodeRunEvent({ ...runEventRow, kind: "exploded" }));
  });

  test("ignores a tag smuggled into the blob, because the column is the tag", () => {
    const event = decode(
      decodeRunEvent({
        ...runEventRow,
        payload: { ...runEventRow.payload, kind: "finished" },
      })
    );
    expect(event.payload.kind).toBe("usage");
  });

  test("rejects a negative sequence number", () => {
    failsToDecode(decodeRunEvent({ ...runEventRow, seq: -1 }));
  });
});

describe("run command", () => {
  test("rejoins the kind column with its blob as one tagged payload", () => {
    const command = decode(decodeRunCommand(runCommandRow));
    expect(command.payload).toEqual({
      kind: "start_session",
      trigger: "research",
    });
  });

  test("rejects a start_session carrying no trigger", () => {
    failsToDecode(decodeRunCommand({ ...runCommandRow, payload: {} }));
  });

  test("rejects an actor kind outside the union", () => {
    failsToDecode(decodeRunCommand({ ...runCommandRow, actorKind: "cron" }));
  });
});
