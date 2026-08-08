import { describe, expect, test } from "bun:test";
import { splitLines, transcriptChars } from "./transcript";
import { parseClaudeTranscript } from "./transcript-claude";

const SESSION = "b3144824-0ff3-4ded-bf94-fa5dd51f9f10";
const THINKING = "weigh the two options";
const TOOL_INPUT = { command: "ls -a", description: "list" };

/**
 * A file shaped like the one Claude Code writes: envelopes of several types,
 * content blocks inside the two that carry a message, UI bookkeeping mixed in,
 * and a last line cut off by a killed process.
 */
const FIXTURE = [
  JSON.stringify({
    message: { content: "build the reader", role: "user" },
    sessionId: SESSION,
    timestamp: "2026-08-01T10:00:00.000Z",
    type: "user",
  }),
  JSON.stringify({ mode: "default", sessionId: SESSION, type: "mode" }),
  JSON.stringify({
    message: {
      content: [
        { signature: "sig", thinking: THINKING, type: "thinking" },
        { text: "Looking at it now.", type: "text" },
        {
          id: "toolu_01",
          input: TOOL_INPUT,
          name: "Bash",
          type: "tool_use",
        },
      ],
      model: "claude-opus-5",
      role: "assistant",
    },
    sessionId: SESSION,
    timestamp: "2026-08-01T10:00:04.000Z",
    type: "assistant",
  }),
  JSON.stringify({
    message: {
      content: [
        {
          content: "permission denied",
          is_error: true,
          tool_use_id: "toolu_01",
          type: "tool_result",
        },
      ],
      role: "user",
    },
    sessionId: SESSION,
    timestamp: "2026-08-01T10:00:05.000Z",
    type: "user",
  }),
  JSON.stringify({
    content: "Stop hook ran",
    level: "info",
    sessionId: SESSION,
    timestamp: "2026-08-01T10:00:06.000Z",
    type: "system",
  }),
  '{"type":"assistant","message":{"content":[{"type":"te',
];

const parsed = parseClaudeTranscript(FIXTURE);

describe("parseClaudeTranscript", () => {
  test("reads the session id from the first envelope that carries one", () => {
    expect(parsed.providerSessionId).toBe(SESSION);
  });

  test("flattens content blocks into one entry each, in file order", () => {
    expect(parsed.entries.map((entry) => entry.role)).toEqual([
      "user",
      "reasoning",
      "assistant",
      "tool_call",
      "tool_result",
      "system",
    ]);
  });

  test("keeps the line each entry came from, so blocks share one", () => {
    expect(parsed.entries.map((entry) => entry.line)).toEqual([
      0, 2, 2, 2, 3, 4,
    ]);
  });

  test("measures reasoning without quoting it", () => {
    const [, reasoning] = parsed.entries;
    expect(reasoning?.text).toBe("");
    expect(reasoning?.chars).toBe(THINKING.length);
  });

  test("carries the tool name, call id and full arguments", () => {
    expect(parsed.entries[3]).toMatchObject({
      callId: "toolu_01",
      role: "tool_call",
      text: JSON.stringify(TOOL_INPUT),
      toolName: "Bash",
    });
  });

  test("reads is_error as a failed tool result, paired by call id", () => {
    expect(parsed.entries[4]).toMatchObject({
      callId: "toolu_01",
      ok: false,
      role: "tool_result",
      text: "permission denied",
    });
  });

  test("leaves ok null where the provider did not say", () => {
    expect(parsed.entries[0]?.ok).toBeNull();
    expect(parsed.entries[2]?.ok).toBeNull();
  });

  test("skips UI bookkeeping and a truncated final line", () => {
    expect(parsed.entries).toHaveLength(6);
  });

  test("joins the text blocks of a tool result written as blocks", () => {
    const withBlocks = parseClaudeTranscript([
      JSON.stringify({
        message: {
          content: [
            {
              content: [
                { text: "first", type: "text" },
                { source: {}, type: "image" },
                { text: "second", type: "text" },
              ],
              tool_use_id: "toolu_02",
              type: "tool_result",
            },
          ],
          role: "user",
        },
        type: "user",
      }),
    ]);
    expect(withBlocks.entries[0]?.text).toBe("first\nsecond");
    expect(withBlocks.entries[0]?.ok).toBe(true);
  });

  test("is total over a file of nothing but garbage", () => {
    expect(parseClaudeTranscript(["", "not json", "[]"])).toEqual({
      entries: [],
      providerSessionId: null,
      usage: [],
    });
  });
});

describe("transcriptChars", () => {
  test("counts reasoning that was measured but not carried", () => {
    const carried = parsed.entries.reduce(
      (total, entry) => total + entry.text.length,
      0
    );
    expect(transcriptChars(parsed.entries)).toBe(carried + THINKING.length);
  });
});

describe("splitLines", () => {
  test("drops blank lines and keeps the rest in order", () => {
    expect(splitLines("a\n\n b \n")).toEqual(["a", " b "]);
  });
});
