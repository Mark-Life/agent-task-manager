/**
 * What the compiler cannot say about the normalization.
 *
 * Three properties are worth a test and the rest is types. That content is
 * measured and not carried — a shell command must not arrive on the timeline
 * with its argv, because that is where a token rides. That a number is null
 * exactly when the provider reported none, since a fabricated `0` is a number
 * someone later averages. And that a turn always reaches a terminus, including
 * the case where the provider simply stopped talking, which is the failure this
 * whole layer exists to make countable.
 *
 * The fixtures are SDK messages trimmed to the fields the harness reads. The
 * SDK's own shapes carry a dozen more that nothing here touches, so each
 * fixture narrows once, in one place, rather than restating a vendor type.
 */

import { describe, expect, test } from "bun:test";
import type { SDKMessage } from "@anthropic-ai/claude-agent-sdk";
import { CostUsd } from "@workspace/domain";
import { makeCursor, normalize, terminusOf } from "./claude-events";

/** An SDK message with only the fields the harness reads. */
const message = (fixture: Record<string, unknown>) =>
  fixture as unknown as SDKMessage;

const SESSION_ID = "01994c48-1f0f-7000-8000-000000000001";

const initMessage = message({
  model: "claude-opus-4-8",
  session_id: SESSION_ID,
  subtype: "init",
  type: "system",
});

/** The four token counts of a finished turn, which is all `usage` is read for. */
const usage = {
  cache_creation_input_tokens: 30,
  cache_read_input_tokens: 40,
  input_tokens: 10,
  output_tokens: 20,
};

/** The cost of the finished turn below, as the database holds it. */
const COST = CostUsd.make("0.123457");

const assistantMessage = (content: readonly Record<string, unknown>[]) =>
  message({ message: { content }, session_id: SESSION_ID, type: "assistant" });

describe("session_init", () => {
  test("reports the provider's session id and the model it actually chose", () => {
    const cursor = makeCursor();
    expect(normalize(cursor, initMessage)).toEqual([
      {
        kind: "session_init",
        model: "claude-opus-4-8",
        provider: "claude",
        providerSessionId: SESSION_ID,
      },
    ]);
    expect(cursor.providerSessionId).toBe(SESSION_ID);
  });
});

describe("assistant blocks", () => {
  test("carries a complete message once, unclipped", () => {
    const text = "x".repeat(1000);
    expect(
      normalize(makeCursor(), assistantMessage([{ text, type: "text" }]))
    ).toEqual([{ kind: "assistant_text", text }]);
  });

  test("measures reasoning instead of quoting it", () => {
    expect(
      normalize(
        makeCursor(),
        assistantMessage([{ thinking: "secret plan", type: "thinking" }])
      )
    ).toEqual([{ chars: 11, durationMs: null, kind: "reasoning" }]);
  });

  test("keeps a shell command's verb and drops its argv", () => {
    const [event] = normalize(
      makeCursor(),
      assistantMessage([
        {
          id: "call-1",
          input: {
            command: "gh api -H 'Authorization: Bearer sk-live-abc123'",
          },
          name: "Bash",
          type: "tool_use",
        },
      ])
    );
    expect(event).toMatchObject({
      callId: "call-1",
      kind: "tool_call",
      summary: "gh api",
      toolName: "Bash",
    });
    expect(JSON.stringify(event)).not.toContain("sk-live-abc123");
  });

  test("keeps the third word, which is what tells two runner calls apart", () => {
    const label = (command: string) =>
      normalize(
        makeCursor(),
        assistantMessage([
          { id: "call-1", input: { command }, name: "Bash", type: "tool_use" },
        ])
      )[0];

    expect(label("bun run typecheck")).toMatchObject({
      summary: "bun run typecheck",
    });
    expect(label("bun run build")).toMatchObject({ summary: "bun run build" });
    // and the bare-word rule still ends the label wherever a value starts
    expect(label("bun run test --coverage")).toMatchObject({
      summary: "bun run test",
    });
    expect(label("psql 'postgres://user:pw@host/db'")).toMatchObject({
      summary: "psql",
    });
  });

  test("names the skill a call ran", () => {
    const [event] = normalize(
      makeCursor(),
      assistantMessage([
        {
          id: "call-4",
          input: { args: "sk-live-abc123", skill: "quality-code" },
          name: "Skill",
          type: "tool_use",
        },
      ])
    );
    expect(event).toMatchObject({ summary: "quality-code", toolName: "Skill" });
    // the name is the whole summary: the arguments are caller text and stay off
    expect(JSON.stringify(event)).not.toContain("sk-live-abc123");
  });

  test("drops the query string of a fetched url", () => {
    const [event] = normalize(
      makeCursor(),
      assistantMessage([
        {
          id: "call-2",
          input: { url: "https://example.com/doc?token=sk-live-abc123" },
          name: "WebFetch",
          type: "tool_use",
        },
      ])
    );
    expect(event).toMatchObject({ summary: "https://example.com/doc" });
    expect(JSON.stringify(event)).not.toContain("sk-live-abc123");
  });

  test("summarizes an unknown tool as nothing at all", () => {
    expect(
      normalize(
        makeCursor(),
        assistantMessage([
          {
            id: "call-3",
            input: { secret: "sk-live-abc123" },
            name: "mcp__executor__execute",
            type: "tool_use",
          },
        ])
      )
    ).toEqual([
      {
        callId: "call-3",
        inputChars: 27,
        kind: "tool_call",
        summary: "",
        toolName: "mcp__executor__execute",
      },
    ]);
  });
});

describe("tool results", () => {
  test("pairs to its call and measures the full output", () => {
    expect(
      normalize(
        makeCursor(),
        message({
          message: {
            content: [
              {
                content: "line one\nline two",
                is_error: true,
                tool_use_id: "call-1",
                type: "tool_result",
              },
            ],
          },
          type: "user",
        })
      )
    ).toEqual([
      {
        callId: "call-1",
        kind: "tool_result",
        ok: false,
        outputChars: 17,
        summary: "line one line two",
      },
    ]);
  });

  test("redacts a secret a tool printed", () => {
    const [event] = normalize(
      makeCursor(),
      message({
        message: {
          content: [
            {
              content: [{ text: "TOKEN=sk-live-abc123def456", type: "text" }],
              tool_use_id: "call-2",
              type: "tool_result",
            },
          ],
        },
        type: "user",
      })
    );
    expect(JSON.stringify(event)).not.toContain("sk-live-abc123def456");
  });
});

describe("rate limit readings", () => {
  test("reads the reset stamp as seconds and stores milliseconds", () => {
    expect(
      normalize(
        makeCursor(),
        message({
          rate_limit_info: {
            rateLimitType: "five_hour",
            resetsAt: 1_800_000_000,
            status: "allowed_warning",
            utilization: 82,
          },
          type: "rate_limit_event",
        })
      )
    ).toEqual([
      {
        costUsd: null,
        inputTokens: null,
        kind: "usage",
        outputTokens: null,
        rateLimitPct: 82,
        rateLimitResetsAtMs: 1_800_000_000_000,
        rateLimitStatus: "allowed_warning",
        rateLimitType: "five_hour",
        turns: null,
      },
    ]);
  });

  test("reports nothing where the provider named no window", () => {
    const [event] = normalize(
      makeCursor(),
      message({
        rate_limit_info: { status: "allowed" },
        type: "rate_limit_event",
      })
    );
    expect(event).toMatchObject({
      rateLimitPct: null,
      rateLimitResetsAtMs: null,
      rateLimitType: null,
    });
  });
});

describe("the terminus", () => {
  test("a clean finish rolls the economics up onto the result", () => {
    const cursor = makeCursor();
    const events = normalize(
      cursor,
      message({
        duration_ms: 4200,
        num_turns: 3,
        result: "done and pushed",
        session_id: SESSION_ID,
        subtype: "success",
        total_cost_usd: 0.123_456_789,
        type: "result",
        usage,
      })
    );
    expect(cursor.terminated).toBe(true);
    expect(events).toEqual([
      {
        costUsd: COST,
        inputTokens: 10,
        kind: "usage",
        outputTokens: 20,
        rateLimitPct: null,
        rateLimitResetsAtMs: null,
        rateLimitStatus: null,
        rateLimitType: null,
        turns: 3,
      },
      {
        costUsd: COST,
        durationMs: 4200,
        errorClass: null,
        errorMessage: null,
        kind: "result",
        outcome: "done",
        providerSessionId: SESSION_ID,
        text: "done and pushed",
        totalTokens: 100,
        turns: 3,
      },
    ]);
  });

  test("a failed turn is classified and still reports what it spent", () => {
    const [, result] = normalize(
      makeCursor(),
      message({
        duration_ms: 900,
        errors: ["429 rate limit exceeded"],
        num_turns: 1,
        session_id: SESSION_ID,
        subtype: "error_during_execution",
        total_cost_usd: 0.5,
        type: "result",
        usage,
      })
    );
    expect(result).toMatchObject({
      costUsd: "0.500000",
      errorClass: "RateLimited",
      errorMessage: "429 rate limit exceeded",
      kind: "result",
      outcome: "errored",
      text: "",
    });
  });

  test("a provider that reported no cost reports null, not zero", () => {
    const [usageEvent] = normalize(
      makeCursor(),
      message({
        duration_ms: 10,
        num_turns: 1,
        result: "",
        session_id: SESSION_ID,
        subtype: "success",
        total_cost_usd: null,
        type: "result",
        usage,
      })
    );
    expect(usageEvent).toMatchObject({ costUsd: null });
  });
});

describe("terminusOf", () => {
  test("adds nothing to a turn that already ended", () => {
    const cursor = makeCursor();
    cursor.terminated = true;
    expect(terminusOf(cursor)).toEqual([]);
  });

  test("names a stream that went quiet, with how far it got", () => {
    const cursor = makeCursor();
    normalize(cursor, initMessage);
    const [result] = terminusOf(cursor);
    expect(result).toEqual({
      costUsd: null,
      durationMs: null,
      errorClass: "NoTerminalEvent",
      errorMessage:
        "the provider stream ended after 1 events without a terminus",
      kind: "result",
      outcome: "no_terminal_event",
      providerSessionId: SESSION_ID,
      text: "",
      totalTokens: null,
      turns: null,
    });
  });
});

describe("messages the harness ignores", () => {
  test("a status ping produces nothing and does not end the turn", () => {
    const cursor = makeCursor();
    expect(
      normalize(cursor, message({ subtype: "status", type: "system" }))
    ).toEqual([]);
    expect(cursor.eventsSeen).toBe(0);
    expect(cursor.terminated).toBe(false);
  });
});
