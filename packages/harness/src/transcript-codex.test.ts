import { describe, expect, test } from "bun:test";
import { parseTranscript } from "./transcript";
import { parseCodexTranscript } from "./transcript-codex";

const SESSION = "019f42f4-342d-7b30-9551-a78e5a2cbe5e";
const SUMMARY = "check the two call sites";
const ARGUMENTS = '{"cmd": "bun test", "workdir": "/repo"}';

/** A line of a rollout file: everything Codex writes is this envelope. */
const line = (type: string, payload: unknown, timestamp: string) =>
  JSON.stringify({ payload, timestamp, type });

/**
 * A file shaped like the one Codex writes: a `session_meta` header, the
 * API-level `response_item` stream, and the `event_msg` stream recording the
 * same prose a second time.
 */
const FIXTURE = [
  line(
    "session_meta",
    { cwd: "/repo", id: SESSION, session_id: SESSION },
    "2026-08-01T10:00:00.000Z"
  ),
  line(
    "response_item",
    {
      content: [{ text: "<permissions instructions>", type: "input_text" }],
      role: "developer",
      type: "message",
    },
    "2026-08-01T10:00:01.000Z"
  ),
  line(
    "response_item",
    {
      content: [
        { text: "<environment_context>", type: "input_text" },
        { text: "run the tests", type: "input_text" },
      ],
      role: "user",
      type: "message",
    },
    "2026-08-01T10:00:02.000Z"
  ),
  line("event_msg", { message: "run the tests", type: "user_message" }, "x"),
  line(
    "response_item",
    {
      encrypted_content: "gAAAAA-ciphertext",
      summary: [{ text: SUMMARY, type: "summary_text" }],
      type: "reasoning",
    },
    "2026-08-01T10:00:03.000Z"
  ),
  line(
    "response_item",
    {
      arguments: ARGUMENTS,
      call_id: "call_1",
      name: "exec_command",
      type: "function_call",
    },
    "2026-08-01T10:00:04.000Z"
  ),
  line(
    "response_item",
    {
      call_id: "call_1",
      output: { content: "1 fail", metadata: { exit_code: 2 } },
      type: "function_call_output",
    },
    "2026-08-01T10:00:05.000Z"
  ),
  line(
    "response_item",
    {
      content: [{ text: "One test fails.", type: "output_text" }],
      role: "assistant",
      type: "message",
    },
    "2026-08-01T10:00:06.000Z"
  ),
  line("event_msg", { message: "One test fails.", type: "agent_message" }, "x"),
  line("event_msg", { info: {}, type: "token_count" }, "x"),
  '{"type":"response_item","payload":{"type":"mess',
];

const parsed = parseCodexTranscript(FIXTURE);

describe("parseCodexTranscript", () => {
  test("reads the session id from the session_meta header", () => {
    expect(parsed.providerSessionId).toBe(SESSION);
  });

  test("reads the API stream and ignores the UI stream that repeats it", () => {
    expect(parsed.entries.map((entry) => entry.role)).toEqual([
      "system",
      "user",
      "reasoning",
      "tool_call",
      "tool_result",
      "assistant",
    ]);
  });

  test("joins the parts of one message into one entry", () => {
    expect(parsed.entries[1]).toMatchObject({
      occurredAt: "2026-08-01T10:00:02.000Z",
      text: "<environment_context>\nrun the tests",
    });
  });

  test("measures the exposed reasoning summary without quoting it", () => {
    expect(parsed.entries[2]).toMatchObject({
      chars: SUMMARY.length,
      text: "",
    });
  });

  test("carries the tool name, call id and full arguments", () => {
    expect(parsed.entries[3]).toMatchObject({
      callId: "call_1",
      text: ARGUMENTS,
      toolName: "exec_command",
    });
  });

  test("believes the exit code over the tool-call status", () => {
    expect(parsed.entries[4]).toMatchObject({
      callId: "call_1",
      ok: false,
      text: "1 fail",
    });
  });

  test("skips token counts, turn markers and a truncated final line", () => {
    expect(parsed.entries).toHaveLength(6);
  });

  test("falls back to the UI stream when the file has no API stream", () => {
    const uiOnly = parseCodexTranscript([
      line("session_meta", { id: SESSION }, "2026-08-01T10:00:00.000Z"),
      line("event_msg", { message: "hi", type: "user_message" }, "t1"),
      line("event_msg", { message: "hello", type: "agent_message" }, "t2"),
      line("event_msg", { info: {}, type: "token_count" }, "t3"),
    ]);
    expect(uiOnly.entries.map((entry) => entry.text)).toEqual(["hi", "hello"]);
    expect(uiOnly.providerSessionId).toBe(SESSION);
  });

  test("names the built-in searches, which carry no name of their own", () => {
    const searches = parseCodexTranscript([
      line(
        "response_item",
        {
          action: { query: "codex docs", type: "search" },
          status: "completed",
          type: "web_search_call",
        },
        "t"
      ),
      line(
        "response_item",
        {
          call_id: "call_2",
          input: "*** Begin Patch",
          name: "apply_patch",
          status: "failed",
          type: "custom_tool_call",
        },
        "t"
      ),
      line(
        "response_item",
        {
          call_id: "call_2",
          output: "Exit code: 0",
          type: "custom_tool_call_output",
        },
        "t"
      ),
    ]);
    expect(searches.entries[0]?.toolName).toBe("web_search");
    expect(searches.entries[1]?.toolName).toBe("apply_patch");
    expect(searches.entries[2]?.ok).toBeNull();
  });

  test("skips an item type it does not know rather than guessing", () => {
    const unknown = parseCodexTranscript([
      line("response_item", { type: "something_new" }, "t"),
    ]);
    expect(unknown.entries).toEqual([]);
  });

  test("is total over a file of nothing but garbage", () => {
    expect(parseCodexTranscript(["", "not json", "[]"])).toEqual({
      entries: [],
      providerSessionId: null,
    });
  });
});

describe("parseTranscript", () => {
  test("dispatches on the provider", () => {
    expect(parseTranscript("codex", FIXTURE)).toEqual(parsed);
  });
});
