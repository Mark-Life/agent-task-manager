import { describe, expect, test } from "bun:test";
import {
  type CodexStep,
  type CodexTurnState,
  initialCodexTurnState,
  stepCodexLine,
} from "./codex-events";

const STARTED_AT_MS = 1000;
const NOW_MS = 4500;

const start = (providerSessionId: string | null = null) =>
  initialCodexTurnState({ providerSessionId, startedAtMs: STARTED_AT_MS });

/** Folds a script of JSONL lines the way the stream does, one state throughout. */
const replay = (
  lines: readonly string[],
  from: CodexTurnState = start()
): CodexStep =>
  lines.reduce<CodexStep>(
    (accumulated, line) => {
      const stepped = stepCodexLine({
        line,
        nowMs: NOW_MS,
        state: accumulated.state,
      });
      return {
        events: [...accumulated.events, ...stepped.events],
        state: stepped.state,
      };
    },
    { events: [], state: from }
  );

const threadStarted = JSON.stringify({
  thread_id: "01920f3e-0000-7000-8000-000000000001",
  type: "thread.started",
});
describe("stepCodexLine", () => {
  test("ignores blank lines, non-JSON, and shapes it does not read", () => {
    const { events, state } = replay([
      "",
      "   ",
      "codex: reading config",
      JSON.stringify({ type: "turn.started" }),
      JSON.stringify({
        item: { id: "i1", items: [], type: "todo_list" },
        type: "item.completed",
      }),
    ]);
    expect(events).toEqual([]);
    expect(state.eventsSeen).toBe(0);
  });

  test("takes the session id from thread.started and reports no model", () => {
    const { events, state } = replay([threadStarted]);
    expect(events).toEqual([
      {
        kind: "session_init",
        model: null,
        provider: "codex",
        providerSessionId: "01920f3e-0000-7000-8000-000000000001",
      },
    ]);
    expect(state.providerSessionId).toBe(
      "01920f3e-0000-7000-8000-000000000001"
    );
  });

  test("keeps the resumed session id when the thread announces none", () => {
    const { state } = replay([], start("thread-from-resume"));
    expect(state.providerSessionId).toBe("thread-from-resume");
  });

  test("emits a complete assistant message and remembers it as the result text", () => {
    const { events, state } = replay([
      JSON.stringify({
        item: { id: "i1", text: "done, PR is up", type: "agent_message" },
        type: "item.completed",
      }),
    ]);
    expect(events).toEqual([
      { kind: "assistant_text", text: "done, PR is up" },
    ]);
    expect(state.lastAssistantText).toBe("done, PR is up");
  });

  test("measures reasoning instead of quoting it", () => {
    const { events } = replay([
      JSON.stringify({
        item: { id: "i2", text: "weighing two options", type: "reasoning" },
        type: "item.completed",
      }),
    ]);
    expect(events).toEqual([
      {
        chars: "weighing two options".length,
        durationMs: null,
        kind: "reasoning",
      },
    ]);
  });

  test("pairs a shell call with its result and strips the shell wrapper", () => {
    const { events } = replay([
      JSON.stringify({
        item: {
          command: "/bin/zsh -lc bun test",
          id: "call-1",
          status: "in_progress",
          type: "command_execution",
        },
        type: "item.started",
      }),
      JSON.stringify({
        item: {
          aggregated_output: "12 pass",
          command: "/bin/zsh -lc bun test",
          exit_code: 0,
          id: "call-1",
          status: "completed",
          type: "command_execution",
        },
        type: "item.completed",
      }),
    ]);
    expect(events).toEqual([
      {
        callId: "call-1",
        inputChars: "/bin/zsh -lc bun test".length,
        kind: "tool_call",
        summary: "bun test",
        toolName: "shell",
      },
      {
        callId: "call-1",
        kind: "tool_result",
        ok: true,
        outputChars: "12 pass".length,
        summary: "12 pass",
      },
    ]);
  });

  test("reports a non-zero command as a failed tool result", () => {
    const { events } = replay([
      JSON.stringify({
        item: {
          aggregated_output: "1 fail",
          command: "bash -c bun test",
          exit_code: 1,
          id: "call-2",
          status: "failed",
          type: "command_execution",
        },
        type: "item.completed",
      }),
    ]);
    expect(events.map((event) => event.kind)).toEqual([
      "tool_call",
      "tool_result",
    ]);
    expect(events[1]).toMatchObject({ ok: false });
  });

  test("synthesizes the call for a patch that is only ever reported complete", () => {
    const { events, state } = replay([
      JSON.stringify({
        item: {
          changes: [
            { kind: "update", path: "src/a.ts" },
            { kind: "add", path: "src/b.ts" },
          ],
          id: "patch-1",
          status: "completed",
          type: "file_change",
        },
        type: "item.completed",
      }),
    ]);
    expect(events).toEqual([
      {
        callId: "patch-1",
        inputChars: "src/a.ts src/b.ts".length,
        kind: "tool_call",
        summary: "src/a.ts src/b.ts",
        toolName: "apply_patch",
      },
      {
        callId: "patch-1",
        kind: "tool_result",
        ok: true,
        outputChars: 0,
        summary: "2 file(s)",
      },
    ]);
    expect(state.openCallIds.size).toBe(0);
  });

  test("namespaces an MCP tool by its server", () => {
    const { events } = replay([
      JSON.stringify({
        item: {
          arguments: { query: "x" },
          id: "mcp-1",
          server: "executor",
          status: "completed",
          tool: "search",
          type: "mcp_tool_call",
        },
        type: "item.completed",
      }),
    ]);
    expect(events[0]).toMatchObject({ toolName: "executor/search" });
  });

  test("treats an error item as a recovered error, not the end of the turn", () => {
    const { events, state } = replay([
      JSON.stringify({
        item: {
          id: "e1",
          message: '{"error":{"message":"429 rate limit reached"}}',
          type: "error",
        },
        type: "item.completed",
      }),
    ]);
    expect(events).toEqual([
      {
        errorClass: "RateLimited",
        errorMessage: "429 rate limit reached",
        kind: "error",
      },
    ]);
    expect(state.fatalMessage).toBeNull();
    expect(state.terminated).toBe(false);
  });

  test("ends a clean turn with a usage reading and a terminus that costs nothing", () => {
    const { events, state } = replay([
      threadStarted,
      JSON.stringify({
        item: { id: "i1", text: "all green", type: "agent_message" },
        type: "item.completed",
      }),
      JSON.stringify({
        type: "turn.completed",
        usage: {
          cached_input_tokens: 100,
          input_tokens: 1200,
          output_tokens: 340,
          reasoning_output_tokens: 60,
        },
      }),
    ]);
    expect(state.terminated).toBe(true);
    expect(events.at(-2)).toEqual({
      costUsd: null,
      inputTokens: 1200,
      kind: "usage",
      outputTokens: 340,
      rateLimitPct: null,
      rateLimitResetsAtMs: null,
      rateLimitStatus: null,
      rateLimitType: null,
      turns: 1,
    });
    expect(events.at(-1)).toEqual({
      costUsd: null,
      durationMs: NOW_MS - STARTED_AT_MS,
      errorClass: null,
      errorMessage: null,
      kind: "result",
      outcome: "done",
      providerSessionId: "01920f3e-0000-7000-8000-000000000001",
      text: "all green",
      totalTokens: 1700,
      turns: 1,
    });
  });

  test("leaves the token total null when the turn reported no usage", () => {
    const { events } = replay([JSON.stringify({ type: "turn.completed" })]);
    expect(events.at(-1)).toMatchObject({ costUsd: null, totalTokens: null });
  });

  test("records a failed turn without emitting a terminus", () => {
    const { events, state } = replay([
      threadStarted,
      JSON.stringify({
        error: { message: '{"message":"model stream disconnected"}' },
        type: "turn.failed",
      }),
    ]);
    expect(events.map((event) => event.kind)).toEqual(["session_init"]);
    expect(state.fatalMessage).toBe("model stream disconnected");
    expect(state.terminated).toBe(false);
  });

  test("shows a stream error and keeps it as the standing cause", () => {
    const { events, state } = replay([
      JSON.stringify({ message: "Reconnecting... 2/5", type: "error" }),
    ]);
    expect(events).toEqual([
      {
        errorClass: "Unknown",
        errorMessage: "Reconnecting... 2/5",
        kind: "error",
      },
    ]);
    expect(state.fatalMessage).toBe("Reconnecting... 2/5");
    expect(state.terminated).toBe(false);
  });

  test("drops the advisory Codex prints about the hook-trust flag", () => {
    // Verbatim from `codex exec --json --dangerously-bypass-hook-trust`, which
    // emits it twice at the top of every run.
    const { events } = replay([
      JSON.stringify({
        item: {
          id: "item_0",
          message:
            "`--dangerously-bypass-hook-trust` is enabled. Enabled hooks may run without review for this invocation.",
          type: "error",
        },
        type: "item.completed",
      }),
    ]);
    expect(events).toEqual([]);
  });

  test("names an unauthenticated turn from the failure Codex ends on", () => {
    // The tail of a real run against an empty CODEX_HOME.
    const { events, state } = replay([
      JSON.stringify({
        message:
          "unexpected status 401 Unauthorized: Missing bearer or basic authentication in header, url: https://api.openai.com/v1/responses",
        type: "error",
      }),
      JSON.stringify({
        error: {
          message:
            "unexpected status 401 Unauthorized: Missing bearer or basic authentication in header, url: https://api.openai.com/v1/responses",
        },
        type: "turn.failed",
      }),
    ]);
    expect(events).toEqual([
      expect.objectContaining({ errorClass: "Unauthenticated", kind: "error" }),
    ]);
    expect(state.terminated).toBe(false);
    expect(state.fatalMessage).toContain("401 Unauthorized");
  });

  test("counts only the lines it understood", () => {
    const { state } = replay(["{", threadStarted, "noise"]);
    expect(state.eventsSeen).toBe(1);
  });
});
