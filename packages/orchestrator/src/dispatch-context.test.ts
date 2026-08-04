import { describe, expect, test } from "bun:test";
import {
  type AgentSession,
  type ChatThread,
  CostUsd,
  newAgentSessionId,
  newRunId,
  newTaskId,
  newThreadId,
  type Task,
  UserId,
  WorkspaceId,
} from "@workspace/domain";
import { hostRunLayout } from "@workspace/harness";
import { DateTime } from "effect";
import {
  type DispatchContext,
  economicsOf,
  errorFieldsOf,
  eventIdentityOf,
  isFailure,
  isFreshSession,
  lostTerminus,
  outcomeOfTerminus,
  type RunFailed,
  type RunFinished,
  resumeSessionIdOf,
  roleOf,
  runIdentityOf,
  subjectOf,
  taskIdOf,
  threadIdOf,
  workspaceIdOf,
} from "./dispatch-context";
import { managerAttachment, workerAttachment } from "./subject";

const at = DateTime.makeUnsafe("2026-08-02T10:00:00.000Z");
const workspaceId = WorkspaceId.make("ws-1");
const taskId = newTaskId();
const threadId = newThreadId();
const runId = newRunId();
const sessionId = newAgentSessionId();

const task: Task = {
  acceptance: null,
  brief: "ship it",
  createdAt: at,
  dispatchTraceparent: null,
  id: taskId,
  metadata: {},
  nextSessionId: null,
  nextSessionNew: false,
  parentTaskId: null,
  parkedUntil: null,
  projectId: null,
  prUrl: null,
  rank: 0,
  repoUrl: null,
  sandboxImage: null,
  status: "in_progress",
  statusChangedAt: at,
  title: "ship it",
  updatedAt: at,
  workspaceId,
};

const thread: ChatThread = {
  chatId: null,
  createdAt: at,
  id: threadId,
  isCurrent: true,
  lastMessageAt: at,
  provider: "claude",
  status: "active",
  title: "what is left this week",
  updatedAt: at,
  userId: UserId.make("person-1"),
  workspaceId,
};

const session: AgentSession = {
  createdAt: at,
  endedAt: null,
  errorMessage: null,
  id: sessionId,
  provider: "claude",
  providerSessionId: "provider-sess-1",
  status: "finished",
  taskId,
  threadId: null,
  unreadWatermarkAt: null,
  unreadWatermarkId: null,
  updatedAt: at,
  workspaceId,
};

const context: DispatchContext = {
  actor: { kind: "orchestrator", loopInstance: "loop-1", runId },
  attached: workerAttachment(task),
  attempt: 1,
  image: "atm.local/base:latest",
  layout: hostRunLayout({ dataRoot: ".data", runId }),
  project: null,
  provider: "claude",
  queueWaitMs: 4200,
  repoUrl: null,
  runId,
  session: {
    mode: "resumed",
    providerSessionId: "provider-sess-1",
    selected: "latest",
    session,
  },
  spanId: "span-1",
  traceId: "trace-1",
  traceparent: "00-trace-1-span-1-01",
  trigger: "status_change",
};

const finished: RunFinished = {
  costUsd: CostUsd.make("0.420000"),
  durationMs: 91_000,
  exitCode: 0,
  finalText: "opened the PR",
  kind: "finished",
  providerSessionId: "provider-sess-1",
  totalTokens: 4200,
  turns: 7,
};

const failedWith = (errorClass: RunFailed["errorClass"]): RunFailed => ({
  costUsd: null,
  durationMs: 12_000,
  errorClass,
  errorMessage: "it went wrong",
  exitCode: 1,
  finalText: "",
  kind: "failed",
  providerSessionId: "provider-sess-1",
  totalTokens: null,
  turns: null,
});

describe("DispatchContext", () => {
  test("answers the resume question once, from the resolved session", () => {
    expect(resumeSessionIdOf(context)).toBe("provider-sess-1");
    expect(isFreshSession(context)).toBe(false);
    expect(
      resumeSessionIdOf({
        ...context,
        session: { mode: "fresh", selected: "new", session },
      })
    ).toBeNull();
  });

  test("hands the container the ids its rows join on", () => {
    expect(runIdentityOf(context)).toEqual({
      runId,
      sessionId,
      taskId,
      traceparent: "00-trace-1-span-1-01",
      workspaceId,
    });
  });

  test("spells the wide event's identity fields once", () => {
    expect(eventIdentityOf(context)).toEqual({
      runId,
      sessionId,
      spanId: "span-1",
      taskId,
      threadId: null,
      traceId: "trace-1",
      workspaceId,
    });
  });

  test("reads the role and the attachment as one fact", () => {
    expect(roleOf(context)).toBe("worker");
    expect(taskIdOf(context)).toBe(taskId);
    expect(threadIdOf(context)).toBeNull();
    expect(subjectOf(context)).toEqual({ id: taskId, kind: "task" });
    expect(workspaceIdOf(context)).toBe(workspaceId);
  });

  test("names a conversation the same way, with no task at all", () => {
    const chat: DispatchContext = {
      ...context,
      attached: managerAttachment(thread),
    };
    expect(roleOf(chat)).toBe("manager");
    expect(taskIdOf(chat)).toBeNull();
    expect(threadIdOf(chat)).toBe(threadId);
    expect(subjectOf(chat)).toEqual({ id: threadId, kind: "thread" });
    expect(workspaceIdOf(chat)).toBe(workspaceId);
    // The container contract has been role-agnostic since it was written: the
    // ids it is started with simply omit the one that is not there.
    expect(runIdentityOf(chat).taskId).toBeNull();
  });
});

describe("RunTerminus", () => {
  test("maps each ending onto the outcome the run row records", () => {
    expect(outcomeOfTerminus(finished)).toBe("done");
    expect(outcomeOfTerminus(failedWith("ProviderCrashed"))).toBe("errored");
    expect(outcomeOfTerminus(failedWith("Interrupted"))).toBe("interrupted");
    expect(outcomeOfTerminus(failedWith("TimedOut"))).toBe("timeout");
    expect(
      outcomeOfTerminus(
        lostTerminus({
          eventsSeen: 12,
          exitCode: null,
          finalText: "",
          providerSessionId: null,
        })
      )
    ).toBe("lost");
  });

  test("counts everything but a clean finish as a failure", () => {
    expect(isFailure(finished)).toBe(false);
    expect(isFailure(failedWith("ProcessFailed"))).toBe(true);
  });

  test("reports no numbers at all for a run nobody heard from", () => {
    expect(
      economicsOf(
        lostTerminus({
          eventsSeen: 12,
          exitCode: 137,
          finalText: "half a thought",
          providerSessionId: "provider-sess-1",
        })
      )
    ).toEqual({
      costUsd: null,
      durationMs: null,
      totalTokens: null,
      turns: null,
    });
  });

  test("leaves the error columns empty on a clean finish", () => {
    expect(errorFieldsOf(finished)).toEqual({
      errorClass: null,
      errorMessage: null,
    });
  });

  test("gives a lost run the harness's name for the same fact", () => {
    expect(
      errorFieldsOf(
        lostTerminus({
          eventsSeen: 12,
          exitCode: null,
          finalText: "",
          providerSessionId: null,
        })
      )
    ).toEqual({
      errorClass: "NoTerminalEvent",
      errorMessage: "the run produced 12 events and no terminus",
    });
  });
});
