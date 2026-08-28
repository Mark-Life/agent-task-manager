/**
 * Run events built the way the wire builds them, for the tests of both readings.
 *
 * Shared rather than copied into each test file: the shaping tests, the memo
 * tests and the render test all need the same eleven kinds, and three drifting
 * copies of an eleven-branch union is how one of them ends up testing a payload
 * the server never sends. Nothing in the app imports this.
 */
import type { RunEvent } from "@workspace/api";
import {
  CostUsd,
  RunCommandId,
  RunEventId,
  type RunEventKind,
  type RunEventPayload,
  RunId,
  TaskId,
  WorkspaceId,
} from "@workspace/domain";
import { DateTime } from "effect";

/** One fixed instant, so a row's clock is a constant rather than the test clock. */
export const AT = DateTime.makeUnsafe("2026-08-08T09:00:00.000Z");

const RUN_ID = RunId.make("6f1a0b4e-0000-4000-8000-0000000000a1");
const TASK_ID = TaskId.make("6f1a0b4e-0000-4000-8000-0000000000a2");
const WORKSPACE_ID = WorkspaceId.make("workspace-under-test");

/** How many digits of a uuid's last group the sequence number is written into. */
const ID_TAIL = 12;

/** A uuid that differs only in its tail, so the sequence number is readable in it. */
const idAt = (seq: number) =>
  RunEventId.make(
    `6f1a0b4e-0000-4000-8000-${seq.toString().padStart(ID_TAIL, "0")}`
  );

interface EventInput {
  /** The harness clock. Defaults to the one fixed instant above. */
  readonly at?: DateTime.Utc;
  readonly payload: RunEventPayload;
  /** The line ordinal the container wrote. Also what the id is derived from. */
  readonly seq?: number;
}

/** One event of a run, as a screen receives it. */
export const eventOf = ({
  at = AT,
  payload,
  seq = 0,
}: EventInput): RunEvent => ({
  createdAt: at,
  id: idAt(seq),
  occurredAt: at,
  payload,
  runId: RUN_ID,
  seq,
  taskId: TASK_ID,
  threadId: null,
  workspaceId: WORKSPACE_ID,
});

/** A whole run in order, numbered as the container would have numbered it. */
export const runOf = (payloads: readonly RunEventPayload[]) =>
  payloads.map((payload, seq) => eventOf({ payload, seq }));

/** One payload, narrowed to the kind it carries. */
export type PayloadOf<K extends RunEventKind> = Extract<
  RunEventPayload,
  { readonly kind: K }
>;

/** Something the agent said, with the character count the ingest would have written. */
export const saidOf = (text: string): PayloadOf<"assistant_message"> => ({
  chars: text.length,
  kind: "assistant_message",
  text,
});

/** A tool invocation, paired to its answer by the id the harness minted. */
export const callOf = (
  callId: string,
  toolName = "Bash"
): PayloadOf<"tool_call"> => ({
  callId,
  inputChars: 24,
  kind: "tool_call",
  summary: `${toolName} --version`,
  toolName,
});

/** What that tool gave back. */
export const resultOf = (
  callId: string,
  ok = true
): PayloadOf<"tool_result"> => ({
  callId,
  kind: "tool_result",
  ok,
  outputChars: 64,
  summary: ok ? "exit 0" : "exit 1: command not found",
});

/** One line of narration. */
export const logOf = (message: string): PayloadOf<"log"> => ({
  kind: "log",
  level: "info",
  message,
});

/**
 * One payload of every kind, for the tests that have to cover all eleven.
 *
 * Keyed by kind and typed against the domain's own list, so a twelfth kind of
 * event is a missing key here — which is what makes "every kind renders" a claim
 * about the union rather than about whichever ten somebody remembered.
 */
export const PAYLOADS: { readonly [K in RunEventKind]: PayloadOf<K> } = {
  assistant_message: saidOf(
    "Ran the migration.\n\n```sql\nselect 1;\n```\n\nIt is **done**."
  ),
  error: {
    errorClass: "TimeoutError",
    errorMessage: "the tool took longer than the harness allows",
    kind: "error",
  },
  failed: {
    errorClass: "SandboxExit",
    errorMessage: "the container stopped answering",
    exitCode: 137,
    kind: "failed",
  },
  finished: {
    costUsd: CostUsd.make("1.25"),
    durationMs: 92_000,
    kind: "finished",
    outcome: "done",
    totalTokens: 48_000,
    turns: 9,
  },
  log: logOf("pulling the sandbox image"),
  reasoning: { chars: 1840, kind: "reasoning" },
  started: {
    kind: "started",
    model: "claude-opus-5",
    promptChars: 4200,
    provider: "claude",
    sandboxImage: "atm/sandbox:latest",
  },
  stopped: {
    commandId: RunCommandId.make("6f1a0b4e-0000-4000-8000-0000000000b1"),
    kind: "stopped",
    requestedByKind: "human",
  },
  tool_call: callOf("toolu_1"),
  tool_result: resultOf("toolu_1"),
  usage: {
    costUsd: CostUsd.make("0.42"),
    inputTokens: 31_000,
    kind: "usage",
    outputTokens: 2100,
    rateLimitPct: 61.4,
    turns: 4,
  },
};
