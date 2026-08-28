/**
 * The Pi transcript parser, against a file Pi actually wrote.
 *
 * The fixture below is the session file of a real invocation — header,
 * `model_change`, `thinking_level_change`, the user's message and the
 * assistant's — with a tool call and its result added from a second run. Its
 * shape is the vendor's, which is the only reason a test here is worth having.
 */

import { describe, expect, test } from "bun:test";
import { parsePiTranscript } from "./transcript-pi";

const SESSION_ID = "01a0476b-6e00-7b19-aaa1-3dd2c8124ab5";

const HEADER = `{"type":"session","version":3,"id":"${SESSION_ID}","timestamp":"2026-08-28T08:10:17.984Z","cwd":"/run/workspace"}`;

const MODEL_CHANGE =
  '{"type":"model_change","id":"65742f19","parentId":null,"timestamp":"2026-08-28T08:10:18.064Z","provider":"openrouter","modelId":"qwen3-coder"}';

const THINKING_CHANGE =
  '{"type":"thinking_level_change","id":"529be79c","parentId":"65742f19","timestamp":"2026-08-28T08:10:18.064Z","thinkingLevel":"off"}';

const USER =
  '{"type":"message","id":"5aae9800","parentId":"529be79c","timestamp":"2026-08-28T08:10:18.077Z","message":{"role":"user","content":[{"type":"text","text":"Say hi in one sentence."}],"timestamp":1787904618075}}';

const ASSISTANT_TOOL_CALL =
  '{"type":"message","id":"a1","parentId":"5aae9800","timestamp":"2026-08-28T08:10:18.100Z","message":{"role":"assistant","content":[{"type":"thinking","thinking":"Short answer wanted.","thinkingSignature":"reasoning_content"},{"type":"toolCall","id":"call_1","name":"read","arguments":{"path":"README.md"}}],"model":"qwen3-coder","usage":{"input":1000,"output":20,"cacheRead":200,"cacheWrite":50,"reasoning":8,"totalTokens":1270,"cost":{"total":0.004}},"stopReason":"toolUse","timestamp":1787904618090}}';

const TOOL_RESULT =
  '{"type":"message","id":"t1","parentId":"a1","timestamp":"2026-08-28T08:10:18.120Z","message":{"role":"toolResult","toolCallId":"call_1","toolName":"read","content":[{"type":"text","text":"# hello"}],"details":{},"isError":false,"timestamp":1787904618110}}';

const ASSISTANT_ANSWER =
  '{"type":"message","id":"e805b279","parentId":"t1","timestamp":"2026-08-28T08:10:18.153Z","message":{"role":"assistant","content":[{"type":"text","text":"Hello from the stub."}],"model":"qwen3-coder","usage":{"input":1234,"output":56,"cacheRead":0,"cacheWrite":0,"reasoning":0,"totalTokens":1290,"cost":{"total":0.004542}},"stopReason":"stop","timestamp":1787904618095}}';

/** The whole file, in the order Pi appended it. */
const LINES = [
  HEADER,
  MODEL_CHANGE,
  THINKING_CHANGE,
  USER,
  ASSISTANT_TOOL_CALL,
  TOOL_RESULT,
  ASSISTANT_ANSWER,
];

describe("parsePiTranscript", () => {
  test("takes the session id from the header Pi writes first", () => {
    // The same value `--session` resumes by and the file is named after.
    expect(parsePiTranscript(LINES).providerSessionId).toBe(SESSION_ID);
  });

  test("reads the conversation and skips Pi's own bookkeeping", () => {
    const { entries } = parsePiTranscript(LINES);
    expect(entries.map((entry) => entry.role)).toEqual([
      "user",
      "reasoning",
      "tool_call",
      "tool_result",
      "assistant",
    ]);
  });

  test("measures thinking and does not quote it", () => {
    const thought = parsePiTranscript(LINES).entries.find(
      (entry) => entry.role === "reasoning"
    );
    expect(thought?.text).toBe("");
    expect(thought?.chars).toBe("Short answer wanted.".length);
  });

  test("pairs a tool call with its result by Pi's own call id", () => {
    const { entries } = parsePiTranscript(LINES);
    const call = entries.find((entry) => entry.role === "tool_call");
    const result = entries.find((entry) => entry.role === "tool_result");
    expect(call?.callId).toBe("call_1");
    expect(call?.toolName).toBe("read");
    expect(result?.callId).toBe("call_1");
    expect(result?.ok).toBe(true);
    expect(result?.text).toBe("# hello");
  });

  test("reads one usage reading per assistant message", () => {
    const { usage } = parsePiTranscript(LINES);
    expect(usage).toHaveLength(2);
    expect(usage[0]).toMatchObject({
      cacheRead: 200,
      cacheWrite: 50,
      // Fresh input plus both cache halves: what the request put in front of
      // the model.
      context: 1250,
      input: 1000,
      model: "qwen3-coder",
      output: 20,
      reasoningOutput: 8,
    });
  });

  test("drops the all-zero reading of a request that never reached a provider", () => {
    const failed =
      '{"type":"message","id":"z","parentId":null,"timestamp":"2026-08-28T08:10:20.000Z","message":{"role":"assistant","content":[],"model":"qwen3-coder","usage":{"input":0,"output":0,"cacheRead":0,"cacheWrite":0,"totalTokens":0,"cost":{"total":0}},"stopReason":"error","errorMessage":"Connection error."}}';
    expect(parsePiTranscript([HEADER, failed]).usage).toEqual([]);
  });

  test("survives a line truncated mid-write, which is a killed run's normal state", () => {
    const truncated = ASSISTANT_TOOL_CALL.slice(0, 120);
    const parsed = parsePiTranscript([...LINES, truncated]);
    expect(parsed.providerSessionId).toBe(SESSION_ID);
    expect(parsed.entries).toHaveLength(5);
  });

  test("parses nothing out of nothing", () => {
    expect(parsePiTranscript([])).toEqual({
      entries: [],
      providerSessionId: null,
      usage: [],
    });
  });
});
