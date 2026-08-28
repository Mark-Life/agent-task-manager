/**
 * The Pi normalizer, against lines captured from a real `pi --mode json` run.
 *
 * Every fixture below was taken off the stream of an actual invocation — the
 * turn, the tool call, the reasoning block and the three-attempt retry — rather
 * than written from the documentation, which is the only way this file is worth
 * anything: what it is holding is the shape of somebody else's release, and a
 * fixture written from a doc tests the doc.
 */

import { describe, expect, test } from "bun:test";
import type { AgentEvent } from "./events";
import { initialPiTurnState, type PiTurnState, stepPiLine } from "./pi-events";

const SESSION_ID = "01a0476b-6e00-7b19-aaa1-3dd2c8124ab5";

const STARTED_AT_MS = 1000;

const start = (providerSessionId: string | null = null) =>
  initialPiTurnState({ providerSessionId, startedAtMs: STARTED_AT_MS });

/** Folds a whole stream, returning everything it emitted and where it ended. */
const run = (
  lines: readonly string[],
  from: PiTurnState = start()
): { readonly events: readonly AgentEvent[]; readonly state: PiTurnState } => {
  let state = from;
  const events: AgentEvent[] = [];
  for (const line of lines) {
    const stepped = stepPiLine({ line, nowMs: STARTED_AT_MS + 250, state });
    events.push(...stepped.events);
    ({ state } = stepped);
  }
  return { events, state };
};

const sessionLine = `{"type":"session","version":3,"id":"${SESSION_ID}","timestamp":"2026-08-28T08:10:17.984Z","cwd":"/run/workspace"}`;

const assistantMessage = (fields: string) =>
  `{"type":"message_end","message":{"role":"assistant",${fields}}}`;

const ANSWERED = assistantMessage(
  '"content":[{"type":"text","text":"Hello from the stub."}],"api":"openai-completions","provider":"stub","model":"stub-model","usage":{"input":1234,"output":56,"cacheRead":0,"cacheWrite":0,"reasoning":0,"totalTokens":1290,"cost":{"input":0.003702,"output":0.00084,"cacheRead":0,"cacheWrite":0,"total":0.004542}},"stopReason":"stop","timestamp":1787904618095'
);

const SETTLED = '{"type":"agent_settled"}';

describe("stepPiLine", () => {
  test("announces the session with the model that actually answered", () => {
    const { events } = run([sessionLine, ANSWERED, SETTLED]);
    expect(events[0]).toEqual({
      kind: "session_init",
      model: "stub-model",
      provider: "pi",
      providerSessionId: SESSION_ID,
    });
  });

  test("announces the session even when no assistant message ever arrived", () => {
    // The turn's transcript has no other address, so losing this event loses
    // the file.
    const { events } = run([sessionLine, SETTLED]);
    const init = events.find((event) => event.kind === "session_init");
    expect(init).toEqual({
      kind: "session_init",
      model: null,
      provider: "pi",
      providerSessionId: SESSION_ID,
    });
  });

  test("announces the session exactly once", () => {
    const { events } = run([sessionLine, ANSWERED, ANSWERED, SETTLED]);
    expect(
      events.filter((event) => event.kind === "session_init")
    ).toHaveLength(1);
  });

  test("takes the model off message_start, before any content exists", () => {
    const started = `{"type":"message_start","message":{"role":"assistant","content":[],"model":"qwen3-coder","usage":{"input":0,"output":0,"totalTokens":0,"cost":{"total":0}},"stopReason":"pending"}}`;
    const { events } = run([sessionLine, started, SETTLED]);
    const init = events.find((event) => event.kind === "session_init");
    expect(init?.kind === "session_init" && init.model).toBe("qwen3-coder");
  });

  test("emits one assistant_text per message, never per delta", () => {
    const delta = `{"type":"message_update","usage":{"input":1,"output":1,"totalTokens":2,"cost":{"total":0}},"assistantMessageEvent":{"type":"text_delta","contentIndex":0,"delta":"Hel"}}`;
    const { events } = run([sessionLine, delta, delta, ANSWERED, SETTLED]);
    const texts = events.filter((event) => event.kind === "assistant_text");
    expect(texts).toEqual([
      { kind: "assistant_text", text: "Hello from the stub." },
    ]);
  });

  test("measures thinking and never quotes it", () => {
    const thought = assistantMessage(
      '"content":[{"type":"thinking","thinking":"Let me think about this carefully.","thinkingSignature":"reasoning_content"},{"type":"text","text":"Done thinking."}],"model":"stub-model","usage":{"input":10,"output":5,"cacheRead":0,"cacheWrite":0,"reasoning":0,"totalTokens":15,"cost":{"total":0.000105}},"stopReason":"stop"'
    );
    const { events } = run([sessionLine, thought, SETTLED]);
    const reasoning = events.find((event) => event.kind === "reasoning");
    expect(reasoning).toEqual({
      chars: "Let me think about this carefully.".length,
      durationMs: null,
      kind: "reasoning",
    });
    expect(JSON.stringify(events)).not.toContain("think about this carefully");
  });

  test("pairs a tool call with its result and keeps the argv out of both", () => {
    const started =
      '{"type":"tool_execution_start","toolCallId":"call_1","toolName":"bash","args":{"command":"gh api /user --header \\"Authorization: Bearer ghp_secret\\""}}';
    const ended =
      '{"type":"tool_execution_end","toolCallId":"call_1","toolName":"bash","result":{"content":[{"type":"text","text":"ok"}],"details":{}},"isError":false}';
    const { events, state } = run([sessionLine, started, ended, SETTLED]);
    const call = events.find((event) => event.kind === "tool_call");
    expect(call).toEqual({
      callId: "call_1",
      inputChars: expect.any(Number),
      kind: "tool_call",
      summary: "gh api /user",
      toolName: "bash",
    });
    expect(JSON.stringify(events)).not.toContain("ghp_secret");
    expect(events).toContainEqual({
      callId: "call_1",
      kind: "tool_result",
      ok: true,
      outputChars: 2,
      summary: "ok",
    });
    expect(state.openCallIds.size).toBe(0);
  });

  test("summarizes a tool it has never heard of as nothing at all", () => {
    // The board tools land here: their arguments are ids and message bodies.
    const started =
      '{"type":"tool_execution_start","toolCallId":"c2","toolName":"messages_post","args":{"taskId":"019f","body":"the whole answer"}}';
    const { events } = run([sessionLine, started, SETTLED]);
    const call = events.find((event) => event.kind === "tool_call");
    expect(call?.kind === "tool_call" && call.summary).toBe("");
    expect(JSON.stringify(events)).not.toContain("the whole answer");
  });

  test("marks a failed tool as failed", () => {
    const ended =
      '{"type":"tool_execution_end","toolCallId":"call_1","toolName":"ls","result":{"content":[{"type":"text","text":"Tool ls not found"}],"details":{}},"isError":true}';
    const { events } = run([sessionLine, ended, SETTLED]);
    const result = events.find((event) => event.kind === "tool_result");
    expect(result?.kind === "tool_result" && result.ok).toBe(false);
  });

  test("carries the cost Pi priced, summed over the turn's requests", () => {
    const { events } = run([sessionLine, ANSWERED, ANSWERED, SETTLED]);
    expect(events.at(-1)).toMatchObject({
      costUsd: "0.009084",
      kind: "result",
      totalTokens: 2580,
    });
  });

  test("reports no cost as null rather than as zero", () => {
    const free = assistantMessage(
      '"content":[{"type":"text","text":"hi"}],"model":"m","stopReason":"stop"'
    );
    const { events } = run([sessionLine, free, SETTLED]);
    expect(events.at(-1)).toMatchObject({
      costUsd: null,
      kind: "result",
      totalTokens: null,
    });
  });

  test("ends a clean turn on a done terminus carrying the last message", () => {
    const { events, state } = run([sessionLine, ANSWERED, SETTLED]);
    const terminus = events.at(-1);
    expect(terminus).toMatchObject({
      errorClass: null,
      errorMessage: null,
      kind: "result",
      outcome: "done",
      providerSessionId: SESSION_ID,
      text: "Hello from the stub.",
    });
    expect(state.terminated).toBe(true);
  });

  /**
   * The case the exit code cannot see. Pi exhausts its retries, settles, and
   * exits zero; the only account of the failure is on the last message.
   */
  test("ends a refused turn as errored, classified from Pi's own words", () => {
    const failed = assistantMessage(
      '"content":[],"model":"stub-model","usage":{"input":0,"output":0,"totalTokens":0,"cost":{"total":0}},"stopReason":"error","errorMessage":"Connection error."'
    );
    const retry =
      '{"type":"auto_retry_start","attempt":1,"maxAttempts":3,"delayMs":2000,"errorMessage":"Connection error."}';
    const { events } = run([sessionLine, failed, retry, failed, SETTLED]);
    // A retry is Pi recovering, and is visible as an error without ending the
    // turn on it.
    expect(events).toContainEqual({
      errorClass: "NetworkFailed",
      errorMessage: "Connection error.",
      kind: "error",
    });
    const terminus = events.at(-1);
    expect(terminus).toMatchObject({
      errorClass: "NetworkFailed",
      errorMessage: "Connection error.",
      kind: "result",
      outcome: "errored",
    });
  });

  test("ends a cancelled turn as interrupted", () => {
    const aborted = assistantMessage(
      '"content":[],"model":"m","stopReason":"aborted"'
    );
    const { events } = run([sessionLine, aborted, SETTLED]);
    const terminus = events.at(-1);
    expect(terminus?.kind === "result" && terminus.outcome).toBe("interrupted");
  });

  test("keeps the session id it was resumed with when the header is missing", () => {
    const { events } = run([ANSWERED, SETTLED], start("resumed-session"));
    const terminus = events.at(-1);
    expect(terminus?.kind === "result" && terminus.providerSessionId).toBe(
      "resumed-session"
    );
  });

  test("ignores a line that is not JSON, a shape it does not read, or blank", () => {
    const { events, state } = run([
      "",
      "not json at all",
      '{"type":"queue_update","steering":[],"followUp":[]}',
      '{"type":"turn_start"}',
    ]);
    expect(events).toEqual([]);
    expect(state.terminated).toBe(false);
    // Only the two decodable lines are counted, which is what tells a silent
    // provider from a truncated one.
    expect(state.eventsSeen).toBe(0);
  });

  test("says nothing about a user message, which is our own prompt", () => {
    const user =
      '{"type":"message_end","message":{"role":"user","content":[{"type":"text","text":"the brief"}],"timestamp":1}}';
    const { events } = run([sessionLine, user, SETTLED]);
    expect(JSON.stringify(events)).not.toContain("the brief");
  });
});
