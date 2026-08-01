import { describe, expect, test } from "bun:test";
import {
  ALLOW_TURN_END,
  COMMENT_MARKER_ENV_VAR,
  commentMarkerPath,
  commentMarkerPathOf,
  decideStop,
  NO_COMMENT_REFUSAL,
  parseStopHookPayload,
  STOP_HOOK_COMMAND_ENV_VAR,
  type StopHookPayload,
  stopHookCommand,
  stopHookResponseOf,
} from "./stop-hook";

/** What Claude sends: no Codex extensions, `last_assistant_message` present or absent. */
const claudePayload = {
  cwd: "/run/workspace",
  hook_event_name: "Stop",
  last_assistant_message: "Done — the tests pass.",
  session_id: "b6f1c0d2-0000-4000-8000-000000000001",
  stop_hook_active: false,
  transcript_path: "/run/agent-home/claude/projects/-run/x.jsonl",
} as const;

/** What Codex sends: the same fields, nulls instead of omissions, plus its own three. */
const codexPayload = {
  cwd: "/run/workspace",
  hook_event_name: "Stop",
  last_assistant_message: null,
  model: "gpt-5.1-codex",
  permission_mode: "bypassPermissions",
  session_id: "01927f9d-0000-7000-8000-000000000002",
  stop_hook_active: false,
  transcript_path: null,
  turn_id: "turn_7",
} as const;

const decided = (payload: StopHookPayload | null, commentPosted: boolean) =>
  decideStop({ commentPosted, payload });

describe("parseStopHookPayload", () => {
  test("reads the claude payload", () => {
    expect(parseStopHookPayload(claudePayload)).toEqual(claudePayload);
  });

  test("reads the codex payload, extensions and nulls included", () => {
    expect(parseStopHookPayload(codexPayload)).toEqual(codexPayload);
  });

  test("ignores fields a harness adds later", () => {
    const parsed = parseStopHookPayload({
      ...claudePayload,
      background_tasks: [{ id: "t1" }],
      effort: { level: "high" },
      prompt_id: "p1",
    });
    expect(parsed?.session_id).toBe(claudePayload.session_id);
  });

  test.each([
    ["a non-stop event", { ...claudePayload, hook_event_name: "SubagentStop" }],
    [
      "a missing stop_hook_active",
      { ...claudePayload, stop_hook_active: null },
    ],
    ["a missing session id", { cwd: "/run", hook_event_name: "Stop" }],
    ["a bare string", "not a payload"],
    ["nothing at all", null],
  ])("returns null for %s", (_name, input) => {
    expect(parseStopHookPayload(input)).toBeNull();
  });
});

describe("decideStop", () => {
  test("refuses a first ending with no comment", () => {
    expect(decided(claudePayload, false)).toEqual({
      kind: "refuse",
      reason: NO_COMMENT_REFUSAL,
    });
  });

  test("allows once the run has commented", () => {
    expect(decided(claudePayload, true)).toEqual({
      kind: "allow",
      why: "comment_posted",
    });
  });

  test("allows a re-entered hook that still has no comment: the retry cap", () => {
    expect(
      decided({ ...claudePayload, stop_hook_active: true }, false)
    ).toEqual({ kind: "allow", why: "retry_spent" });
  });

  test("prefers the comment over the spent retry when both hold", () => {
    expect(decided({ ...claudePayload, stop_hook_active: true }, true)).toEqual(
      {
        kind: "allow",
        why: "comment_posted",
      }
    );
  });

  test("allows an unreadable payload rather than wedging the run", () => {
    expect(decided(null, false)).toEqual({
      kind: "allow",
      why: "unreadable_payload",
    });
  });

  test("decides the same way for both harnesses", () => {
    expect(decided(codexPayload, false)).toEqual(decided(claudePayload, false));
  });
});

describe("stopHookResponseOf", () => {
  test("blocks with a non-empty reason, which codex requires", () => {
    const response = stopHookResponseOf(decided(claudePayload, false));
    expect(response.decision).toBe("block");
    expect(response.reason?.length).toBeGreaterThan(0);
    expect(response.reason).toBe(NO_COMMENT_REFUSAL);
  });

  test("never aborts the run when it refuses a turn", () => {
    expect(
      stopHookResponseOf(decided(claudePayload, false)).continue
    ).toBeUndefined();
  });

  test("allows without a decision field", () => {
    expect(stopHookResponseOf(decided(claudePayload, true))).toEqual(
      ALLOW_TURN_END
    );
    expect(ALLOW_TURN_END.decision).toBeUndefined();
  });
});

describe("commentMarkerPath", () => {
  test("defaults to the run directory inside the container", () => {
    expect(commentMarkerPath({})).toBe("/run/comment-posted");
  });

  test("takes the override when one is set", () => {
    expect(
      commentMarkerPath({ [COMMENT_MARKER_ENV_VAR]: " /tmp/run-9/marker " })
    ).toBe("/tmp/run-9/marker");
  });

  test("treats a blank override as unset", () => {
    expect(commentMarkerPath({ [COMMENT_MARKER_ENV_VAR]: "  " })).toBe(
      "/run/comment-posted"
    );
  });

  test("sits beside the event log of whichever layout is asked", () => {
    expect(
      commentMarkerPathOf({
        agentHomeDir: "/data/runs/r1/agent-home",
        eventLogPath: "/data/runs/r1/events.jsonl",
        runDir: "/data/runs/r1",
      })
    ).toBe("/data/runs/r1/comment-posted");
  });
});

describe("stopHookCommand", () => {
  test("is null when the sandbox wired no hook", () => {
    expect(stopHookCommand({})).toBeNull();
    expect(stopHookCommand({ [STOP_HOOK_COMMAND_ENV_VAR]: "" })).toBeNull();
  });

  test("is the configured command", () => {
    expect(
      stopHookCommand({
        [STOP_HOOK_COMMAND_ENV_VAR]: "bun /opt/atm/stop-hook.ts",
      })
    ).toBe("bun /opt/atm/stop-hook.ts");
  });
});
