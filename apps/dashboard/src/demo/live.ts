/**
 * Keeps the demo's live runs moving: while a run's timeline is open, a new
 * tool call lands every few seconds, the way a working agent's would.
 */

import type { Run, RunEvent } from "@workspace/api";
import { newRunEventId, type SessionProvider } from "@workspace/domain";
import { Schedule, Stream } from "effect";
import { now } from "./ids";
import { db } from "./store";

const TICK = "7 seconds";

/** Rough sizes, so the timeline's "chars in" and "chars out" look real. */
const INPUT_SCALE = 4;
const OUTPUT_SCALE = 40;

interface Call {
  readonly result: string;
  readonly summary: string;
  readonly tool: string;
}

const CALLS: Record<SessionProvider, readonly Call[]> = {
  claude: [
    { result: "84 lines", summary: "Read src/lib/format.ts", tool: "Read" },
    { result: "3 matches", summary: "Grep 'revalidate' src", tool: "Grep" },
    { result: "+7 −2", summary: "Edit src/lib/format.ts", tool: "Edit" },
    { result: "no errors", summary: "bun run typecheck", tool: "Bash" },
    { result: "52 pass, 0 fail", summary: "bun test", tool: "Bash" },
  ],
  codex: [
    {
      result: "11 matches",
      summary: "rg -n 'useApiStream' apps",
      tool: "shell",
    },
    {
      result: "120 lines",
      summary: "apps/gateway/src/sse.ts",
      tool: "read_file",
    },
    {
      result: "+18 −4",
      summary: "apps/gateway/src/sse.ts",
      tool: "apply_patch",
    },
    { result: "no errors", summary: "bun run check", tool: "shell" },
    {
      result: "186 pass, 0 fail",
      summary: "bun test apps/gateway",
      tool: "shell",
    },
  ],
  pi: [
    {
      result: "6 results",
      summary: "search: Cascais lunch near station",
      tool: "web_search",
    },
    { result: "38 lines", summary: "read day-3-sintra.md", tool: "read" },
    { result: "+12 lines", summary: "edit day-3-sintra.md", tool: "edit" },
    {
      result: "4 results",
      summary: "search: last train Cascais to Lisbon",
      tool: "web_search",
    },
  ],
};

const lastSeq = (run: Run) =>
  Math.max(0, ...db.events.filter((e) => e.runId === run.id).map((e) => e.seq));

const append = (run: Run, payload: RunEvent["payload"]) => {
  const at = now();
  const event: RunEvent = {
    createdAt: at,
    id: newRunEventId(),
    occurredAt: at,
    payload,
    runId: run.id,
    seq: lastSeq(run) + 1,
    taskId: run.taskId,
    threadId: null,
    workspaceId: run.workspaceId,
  };
  db.events.push(event);
  return event;
};

/** The next tool call and its result, for as long as the stream is open. */
export const liveEvents = (run: Run) => {
  const calls = CALLS[run.provider];
  return Stream.fromSchedule(Schedule.spaced(TICK)).pipe(
    Stream.flatMap((tick) => {
      const call = calls[tick % calls.length] ?? calls[0];
      if (call === undefined) {
        return Stream.empty;
      }
      const callId = `live_${run.id}_${tick}`;
      return Stream.make(
        append(run, {
          callId,
          inputChars: call.summary.length * INPUT_SCALE,
          kind: "tool_call",
          summary: call.summary,
          toolName: call.tool,
        }),
        append(run, {
          callId,
          kind: "tool_result",
          ok: true,
          outputChars: call.result.length * OUTPUT_SCALE,
          summary: call.result,
        })
      );
    })
  );
};
