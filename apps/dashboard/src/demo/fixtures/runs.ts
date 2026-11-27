/**
 * Runs, sessions, events and transcripts, all derived from `./scripts`.
 */

import type {
  AgentSession,
  AgentSessionUsage,
  Run,
  RunEvent,
  TaskMessage,
  Transcript,
  TranscriptEntry,
} from "@workspace/api";
import {
  AgentSessionId,
  CostUsd,
  RunEventId,
  RunId,
  type TaskId,
  TaskMessageId,
} from "@workspace/domain";
import { DateTime } from "effect";
import { ago, DEMO_WORKSPACE, demoUuid } from "@/demo/ids";
import { type RunScript, SCRIPTS, type Step } from "./scripts";
import { TASKS, taskIdOf } from "./tasks";

const MS_PER_MINUTE = 60_000;
const TOKENS_PER_STEP = 9400;
const CONTEXT_WINDOW = 400_000;
const USD_PER_KTOKEN = 0.012;

export interface DemoRun {
  readonly events: readonly RunEvent[];
  readonly run: Run;
  readonly session: AgentSession;
  readonly transcript: Transcript;
  readonly usage: AgentSessionUsage;
}

const costOf = (tokens: number) =>
  CostUsd.make(((tokens / 1000) * USD_PER_KTOKEN).toFixed(2));

/** An instant `fraction` of the way through a run. */
const within = (script: RunScript, fraction: number) =>
  ago(script.started - script.minutes * fraction);

const payloadsOf = (step: Step, index: number): RunEvent["payload"][] => {
  const callId = `call_${index}`;
  switch (step.kind) {
    case "say":
      return [
        {
          chars: step.text.length,
          kind: "assistant_message",
          text: step.text,
        },
      ];
    case "think":
      return [{ chars: step.text.length, kind: "reasoning" }];
    case "log":
      return [{ kind: "log", level: "warn", message: step.text }];
    default:
      return [
        {
          callId,
          inputChars: step.summary.length * 4,
          kind: "tool_call",
          summary: step.summary,
          toolName: step.tool,
        },
        {
          callId,
          kind: "tool_result",
          ok: step.ok ?? true,
          outputChars: step.result.length * 40,
          summary: step.result,
        },
      ];
  }
};

const tokensOf = (script: RunScript) => script.steps.length * TOKENS_PER_STEP;

const eventsOf = (
  script: RunScript,
  runId: RunId,
  taskId: TaskId,
  n: number
) => {
  const live = script.outcome === null;
  const tokens = tokensOf(script);
  const middle = script.steps.flatMap(payloadsOf);
  const payloads: RunEvent["payload"][] = [
    {
      kind: "started",
      model: script.model,
      promptChars: 3800,
      provider: script.provider,
      sandboxImage: "atm-agent:arm64",
    },
    ...middle,
    {
      costUsd: costOf(tokens),
      inputTokens: Math.round(tokens * 0.93),
      kind: "usage",
      outputTokens: Math.round(tokens * 0.07),
      rateLimitPct: 31,
      turns: script.steps.length,
    },
  ];
  if (!live) {
    payloads.push({
      costUsd: costOf(tokens),
      durationMs: script.minutes * MS_PER_MINUTE,
      kind: "finished",
      outcome: script.outcome ?? "done",
      totalTokens: tokens,
      turns: script.steps.length,
    });
  }
  return payloads.map(
    (payload, seq): RunEvent => ({
      createdAt: within(script, seq / payloads.length),
      id: RunEventId.make(demoUuid("event", n * 100 + seq)),
      occurredAt: within(script, seq / payloads.length),
      payload,
      runId,
      seq: seq + 1,
      taskId,
      threadId: null,
      workspaceId: DEMO_WORKSPACE,
    })
  );
};

const entry = (
  fields: Partial<TranscriptEntry> & Pick<TranscriptEntry, "role" | "text">,
  line: number,
  at: DateTime.Utc
): TranscriptEntry => ({
  callId: null,
  chars: fields.text.length,
  occurredAt: DateTime.formatIso(at),
  ok: null,
  toolName: null,
  ...fields,
  line,
});

const transcriptOf = (script: RunScript, brief: string): Transcript => {
  const entries: TranscriptEntry[] = [
    entry({ role: "user", text: brief }, 1, within(script, 0)),
  ];
  script.steps.forEach((step, index) => {
    const at = within(script, (index + 1) / (script.steps.length + 1));
    const line = entries.length + 1;
    if (step.kind === "say") {
      entries.push(entry({ role: "assistant", text: step.text }, line, at));
    } else if (step.kind === "think") {
      entries.push(entry({ role: "reasoning", text: step.text }, line, at));
    } else if (step.kind === "log") {
      entries.push(entry({ role: "system", text: step.text }, line, at));
    } else {
      const callId = `call_${index}`;
      entries.push(
        entry(
          {
            callId,
            role: "tool_call",
            text: step.summary,
            toolName: step.tool,
          },
          line,
          at
        ),
        entry(
          {
            callId,
            ok: step.ok ?? true,
            role: "tool_result",
            text: step.result,
            toolName: step.tool,
          },
          line + 1,
          at
        )
      );
    }
  });
  return { entries, providerSessionId: null, usage: [] };
};

const toolCountsOf = (script: RunScript) => {
  const counts = new Map<string, { calls: number; errors: number }>();
  for (const step of script.steps) {
    if (step.kind === "tool") {
      const count = counts.get(step.tool) ?? { calls: 0, errors: 0 };
      counts.set(step.tool, {
        calls: count.calls + 1,
        errors: count.errors + (step.ok === false ? 1 : 0),
      });
    }
  }
  return [...counts].map(([name, count]) => ({ name, ...count }));
};

const usageOf = (
  script: RunScript,
  sessionId: AgentSessionId
): AgentSessionUsage => {
  const tokens = tokensOf(script);
  const growth = script.steps.map((_, index) => ({
    cacheReadTokens: Math.round(
      tokens * 0.6 * ((index + 1) / script.steps.length)
    ),
    contextTokens: Math.round(
      (tokens * 0.8 * (index + 1)) / script.steps.length
    ),
    inputTokens: TOKENS_PER_STEP,
    occurredAt: null,
    outputTokens: Math.round(TOKENS_PER_STEP * 0.07),
  }));
  return {
    sessionId,
    usage: {
      computedAt: within(script, 1),
      contextWindow: CONTEXT_WINDOW,
      contextWindowSource: "reported",
      cost: {
        pricedRequests: script.steps.length,
        priceTableEffective: "2026-11-01",
        priceTableVersion: 4,
        totalUsd: costOf(tokens),
        unpricedModels: [],
        unpricedRequests: 0,
      },
      entries: script.steps.length * 2 + 1,
      finalContextTokens: Math.round(tokens * 0.8),
      growth,
      growthSampled: false,
      largestEntries: [],
      models: [script.model],
      peakContextTokens: Math.round(tokens * 0.8),
      provider: script.provider,
      requests: script.steps.length,
      toolCalls: toolCountsOf(script),
      totals: {
        cacheReadTokens: Math.round(tokens * 0.6),
        cacheWriteTokens: Math.round(tokens * 0.2),
        inputTokens: Math.round(tokens * 0.93),
        outputTokens: Math.round(tokens * 0.07),
        reasoningOutputTokens: Math.round(tokens * 0.02),
      },
    },
    workspaceId: DEMO_WORKSPACE,
  };
};

const buildRun = (script: RunScript, n: number): DemoRun => {
  const taskId = taskIdOf(script.taskKey);
  const task = TASKS.find((candidate) => candidate.id === taskId);
  const runId = RunId.make(demoUuid("run", n));
  const sessionId = AgentSessionId.make(demoUuid("session", n));
  const live = script.outcome === null;
  const tokens = tokensOf(script);
  const startedAt = ago(script.started);
  const finishedAt = live ? null : within(script, 1);
  const run: Run = {
    agentSessionId: sessionId,
    attempt: 1,
    branch: `atm/${script.taskKey}`,
    containerId: live ? `atm-run-${n.toString(16)}` : null,
    costUsd: live ? null : costOf(tokens),
    createdAt: startedAt,
    durationMs: live ? null : script.minutes * MS_PER_MINUTE,
    errorClass: null,
    errorMessage: null,
    exitCode: live ? null : 0,
    finishedAt,
    id: runId,
    model: script.model,
    outcome: script.outcome,
    provider: script.provider,
    role: "worker",
    sandboxImage: "atm-agent:arm64",
    startedAt,
    status: live ? "running" : "finished",
    taskId,
    threadId: null,
    totalTokens: live ? null : tokens,
    traceId: null,
    trigger: script.trigger,
    turns: script.steps.length,
    updatedAt: finishedAt ?? startedAt,
    workspaceId: DEMO_WORKSPACE,
  };
  const session: AgentSession = {
    createdAt: startedAt,
    endedAt: finishedAt,
    errorMessage: null,
    id: sessionId,
    provider: script.provider,
    providerSessionId: null,
    status: live ? "running" : "finished",
    taskId,
    threadId: null,
    unreadWatermarkAt: null,
    unreadWatermarkId: null,
    updatedAt: finishedAt ?? startedAt,
    workspaceId: DEMO_WORKSPACE,
  };
  return {
    events: eventsOf(script, runId, taskId, n),
    run,
    session,
    transcript: transcriptOf(script, task?.brief ?? ""),
    usage: usageOf(script, sessionId),
  };
};

export const RUNS: readonly DemoRun[] = Object.values(SCRIPTS).map(
  (script, index) => buildRun(script, index + 1)
);

/** The agent's last words on a finished run, posted on the task's thread. */
export const RUN_MESSAGES: readonly TaskMessage[] = RUNS.flatMap(
  (demo, index) => {
    const script = Object.values(SCRIPTS)[index];
    const last = [...(script?.steps ?? [])]
      .reverse()
      .find((step) => step.kind === "say");
    if (demo.run.status !== "finished" || last?.kind !== "say") {
      return [];
    }
    const at = demo.run.finishedAt ?? demo.run.createdAt;
    return [
      {
        agentSessionId: demo.session.id,
        authorKind: "agent",
        authorUserId: null,
        body: last.text,
        createdAt: at,
        id: TaskMessageId.make(demoUuid("message", index + 1)),
        kind: "message",
        runId: demo.run.id,
        taskId: demo.run.taskId ?? taskIdOf(script?.taskKey ?? ""),
        updatedAt: at,
        workspaceId: DEMO_WORKSPACE,
      } satisfies TaskMessage,
    ];
  }
);
