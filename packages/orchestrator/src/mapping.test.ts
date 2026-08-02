import { describe, expect, test } from "bun:test";
import {
  RUN_EVENT_PAYLOAD_BUDGET_BYTES,
  RUN_EVENT_SUMMARY_BUDGET_BYTES,
  RUN_EVENT_TEXT_BUDGET_BYTES,
  RunEventPayload,
} from "@workspace/domain";
import {
  AgentEvent,
  type AgentEventRecord,
  costUsdOf,
  runEventKindOf,
} from "@workspace/harness";
import { DateTime, Schema } from "effect";
import {
  clipToBytes,
  type MappingContext,
  toRunEventDrafts,
  toRunEventPayload,
} from "./mapping";

const context: MappingContext = {
  exitCode: 1,
  promptChars: 512,
  sandboxImage: "atm.local/base:latest",
};

/** One event per kind, so coverage is asserted rather than assumed. */
const samples: Readonly<Record<AgentEvent["kind"], AgentEvent>> = {
  assistant_text: { kind: "assistant_text", text: "opened the PR" },
  error: {
    errorClass: "NetworkFailed",
    errorMessage: "socket hang up",
    kind: "error",
  },
  log: { kind: "log", level: "info", message: "cloning" },
  reasoning: { chars: 900, durationMs: 120, kind: "reasoning" },
  result: {
    costUsd: costUsdOf(0.42),
    durationMs: 91_000,
    errorClass: null,
    errorMessage: null,
    kind: "result",
    outcome: "done",
    providerSessionId: "sess-1",
    text: "done",
    totalTokens: 4200,
    turns: 7,
  },
  session_init: {
    kind: "session_init",
    model: "claude-sonnet-4-6",
    provider: "claude",
    providerSessionId: "sess-1",
  },
  subagent_done: {
    description: "review the diff",
    durationMs: 4000,
    kind: "subagent_done",
    status: "completed",
    subagentId: "sub-1",
    toolUses: 3,
    totalTokens: 900,
  },
  subagent_started: {
    description: "review the diff",
    kind: "subagent_started",
    subagentId: "sub-1",
  },
  tool_call: {
    callId: "call-7",
    inputChars: 214,
    kind: "tool_call",
    summary: "read src/index.ts",
    toolName: "Read",
  },
  tool_result: {
    callId: "call-7",
    kind: "tool_result",
    ok: true,
    outputChars: 4096,
    summary: "214 lines",
  },
  usage: {
    costUsd: null,
    inputTokens: null,
    kind: "usage",
    outputTokens: null,
    rateLimitPct: 41,
    rateLimitResetsAtMs: null,
    rateLimitStatus: "allowed_warning",
    rateLimitType: "5h",
    turns: null,
  },
};

const at = DateTime.makeUnsafe("2026-08-02T10:00:00.000Z");

const recordOf = (event: AgentEvent): AgentEventRecord => ({
  event,
  occurredAt: at,
});

const decodePayload = Schema.decodeUnknownSync(RunEventPayload);
const byteLength = (text: string) => new TextEncoder().encode(text).length;

describe("clipToBytes", () => {
  test("passes text that already fits through untouched", () => {
    expect(clipToBytes("short", 64)).toBe("short");
  });

  test("clips to the byte budget, not the character count", () => {
    const emoji = "🙂".repeat(100);
    const clipped = clipToBytes(emoji, 21);
    expect(byteLength(clipped)).toBeLessThanOrEqual(21);
    expect(clipped).toBe("🙂".repeat(5));
  });

  test("never cuts a character in half", () => {
    // Four bytes per emoji: every budget in between lands mid-character.
    for (const budget of [1, 2, 3, 5, 6, 7]) {
      const clipped = clipToBytes("🙂🙂", budget);
      expect(clipped).not.toContain("�");
      expect(byteLength(clipped)).toBeLessThanOrEqual(budget);
    }
  });
});

describe("toRunEventPayload", () => {
  test("covers every normalized event kind", () => {
    expect(new Set(Object.keys(samples))).toEqual(
      new Set(AgentEvent.discriminants)
    );
  });

  test("produces the kind the harness says it produces", () => {
    for (const event of Object.values(samples)) {
      expect(toRunEventPayload(event, context).kind).toBe(
        runEventKindOf(event)
      );
    }
  });

  test("produces a payload the domain schema accepts", () => {
    for (const event of Object.values(samples)) {
      expect(() =>
        decodePayload(toRunEventPayload(event, context))
      ).not.toThrow();
    }
  });

  test("carries what only the caller knows onto the started payload", () => {
    expect(toRunEventPayload(samples.session_init, context)).toEqual({
      kind: "started",
      model: "claude-sonnet-4-6",
      promptChars: 512,
      provider: "claude",
      sandboxImage: "atm.local/base:latest",
    });
  });

  test("leaves an unclipped assistant message without truncation markers", () => {
    const payload = toRunEventPayload(samples.assistant_text, context);
    expect(payload).toEqual({
      chars: "opened the PR".length,
      kind: "assistant_message",
      text: "opened the PR",
    });
  });

  test("shows the cut beside a clipped assistant message", () => {
    const text = "x".repeat(RUN_EVENT_TEXT_BUDGET_BYTES + 500);
    const payload = toRunEventPayload(
      { kind: "assistant_text", text },
      context
    );
    expect(payload).toEqual({
      chars: RUN_EVENT_TEXT_BUDGET_BYTES,
      kind: "assistant_message",
      originalChars: text.length,
      text: "x".repeat(RUN_EVENT_TEXT_BUDGET_BYTES),
      truncated: true,
    });
  });

  test("keeps a clipped payload under the ceiling the repository enforces", () => {
    const payload = toRunEventPayload(
      { kind: "assistant_text", text: "🙂".repeat(200_000) },
      context
    );
    expect(byteLength(JSON.stringify(payload))).toBeLessThan(
      RUN_EVENT_PAYLOAD_BUDGET_BYTES
    );
  });

  test("holds a tool summary to the summary budget, with the real size beside it", () => {
    const payload = toRunEventPayload(
      {
        callId: "call-9",
        inputChars: 900_000,
        kind: "tool_call",
        summary: "s".repeat(RUN_EVENT_SUMMARY_BUDGET_BYTES * 2),
        toolName: "Bash",
      },
      context
    );
    expect(payload).toEqual({
      callId: "call-9",
      inputChars: 900_000,
      kind: "tool_call",
      summary: "s".repeat(RUN_EVENT_SUMMARY_BUDGET_BYTES),
      toolName: "Bash",
    });
  });

  test("clips a tool result summary too", () => {
    const payload = toRunEventPayload(
      {
        callId: "call-9",
        kind: "tool_result",
        ok: false,
        outputChars: 900_000,
        summary: "o".repeat(RUN_EVENT_SUMMARY_BUDGET_BYTES + 1),
      },
      context
    );
    expect(decodePayload(payload)).toHaveProperty(
      "summary",
      "o".repeat(RUN_EVENT_SUMMARY_BUDGET_BYTES)
    );
  });

  test("reads a provider's missing numbers as zero on a usage row, never as a lie about cost", () => {
    expect(toRunEventPayload(samples.usage, context)).toEqual({
      costUsd: null,
      inputTokens: 0,
      kind: "usage",
      outputTokens: 0,
      rateLimitPct: 41,
      turns: 0,
    });
  });

  test("logs a subagent's lifecycle, since the domain has no kind for it", () => {
    expect(toRunEventPayload(samples.subagent_started, context)).toEqual({
      kind: "log",
      level: "info",
      message: "subagent started: review the diff [sub-1]",
    });
    expect(toRunEventPayload(samples.subagent_done, context)).toEqual({
      kind: "log",
      level: "info",
      message: "subagent completed: review the diff [sub-1]",
    });
  });

  test("rolls a clean terminus up into the finished payload", () => {
    expect(toRunEventPayload(samples.result, context)).toEqual({
      costUsd: costUsdOf(0.42),
      durationMs: 91_000,
      kind: "finished",
      outcome: "done",
      totalTokens: 4200,
      turns: 7,
    });
  });

  test("zeroes only the payload's required counts, on the clean path", () => {
    const payload = toRunEventPayload(
      {
        costUsd: null,
        durationMs: null,
        errorClass: null,
        errorMessage: null,
        kind: "result",
        outcome: "done",
        providerSessionId: null,
        text: "",
        totalTokens: null,
        turns: null,
      },
      context
    );
    expect(payload).toEqual({
      costUsd: null,
      durationMs: 0,
      kind: "finished",
      outcome: "done",
      totalTokens: 0,
      turns: 0,
    });
  });

  test("carries the classification and the exit code onto a failed terminus", () => {
    expect(
      toRunEventPayload(
        {
          costUsd: null,
          durationMs: null,
          errorClass: "RateLimited",
          errorMessage: "429 too many requests",
          kind: "result",
          outcome: "errored",
          providerSessionId: "sess-1",
          text: "",
          totalTokens: null,
          turns: null,
        },
        context
      )
    ).toEqual({
      errorClass: "RateLimited",
      errorMessage: "429 too many requests",
      exitCode: 1,
      kind: "failed",
    });
  });

  test("names an unclassified failure rather than leaving the field empty", () => {
    expect(
      toRunEventPayload(
        {
          costUsd: null,
          durationMs: null,
          errorClass: null,
          errorMessage: null,
          kind: "result",
          outcome: "no_terminal_event",
          providerSessionId: null,
          text: "",
          totalTokens: null,
          turns: null,
        },
        context
      )
    ).toEqual({
      errorClass: "Unknown",
      errorMessage: "the turn ended no_terminal_event",
      exitCode: 1,
      kind: "failed",
    });
  });
});

describe("toRunEventDrafts", () => {
  test("numbers drafts by their line ordinal", () => {
    const drafts = toRunEventDrafts(
      [
        recordOf(samples.session_init),
        recordOf(samples.tool_call),
        recordOf(samples.result),
      ],
      context
    );
    expect(drafts.map((draft) => draft.seq)).toEqual([0, 1, 2]);
    expect(drafts.map((draft) => draft.payload.kind)).toEqual([
      "started",
      "tool_call",
      "finished",
    ]);
  });

  test("lets an undecodable line consume its ordinal, so a re-ingest still collides", () => {
    const drafts = toRunEventDrafts(
      [recordOf(samples.session_init), null, recordOf(samples.result)],
      context
    );
    expect(drafts.map((draft) => draft.seq)).toEqual([0, 2]);
  });

  test("keeps the harness clock each line was written with", () => {
    const [draft] = toRunEventDrafts([recordOf(samples.log)], context);
    expect(draft?.occurredAt).toEqual(at);
  });
});
