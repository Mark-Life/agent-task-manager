import { describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { HANDOFF_FILENAME, TaskId } from "@workspace/domain";
import { spawn } from "bun";
import {
  ALLOW_TURN_END,
  decideStop,
  MESSAGE_MARKER_ENV_VAR,
  MESSAGE_MARKER_FILE,
  messageMarkerPath,
  messageMarkerPathOf,
  messageRuleApplies,
  NO_MESSAGE_REFUSAL,
  parseStopHookPayload,
  STOP_HOOK_COMMAND_ENV_VAR,
  type StopHookPayload,
  stopHookCommand,
  stopHookResponseOf,
} from "./stop-hook";
import { ENTRYPOINT_BUNDLE_FILE, STOP_HOOK_FLAG } from "./turn-spec";

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

const decided = (payload: StopHookPayload | null, messagePosted: boolean) =>
  decideStop({ messagePosted, payload });

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
  test("refuses a first ending with no message", () => {
    expect(decided(claudePayload, false)).toEqual({
      kind: "refuse",
      reason: NO_MESSAGE_REFUSAL,
    });
  });

  test("allows once the run has posted", () => {
    expect(decided(claudePayload, true)).toEqual({
      kind: "allow",
      why: "message_posted",
    });
  });

  test("allows a re-entered hook that still has no message: the retry cap", () => {
    expect(
      decided({ ...claudePayload, stop_hook_active: true }, false)
    ).toEqual({ kind: "allow", why: "retry_spent" });
  });

  test("prefers the message over the spent retry when both hold", () => {
    expect(decided({ ...claudePayload, stop_hook_active: true }, true)).toEqual(
      {
        kind: "allow",
        why: "message_posted",
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

  test("gives an agent that cannot reach the board a way to comply", () => {
    // The refusal is read by an agent that has just failed to post a message,
    // and one reason for that is a board it can no longer reach. Without this
    // it is told to do the one thing it has already found it cannot do.
    expect(NO_MESSAGE_REFUSAL).toContain(HANDOFF_FILENAME);
    expect(NO_MESSAGE_REFUSAL).toContain(
      "read off the disk and posted for you"
    );
  });

  test("asks for a short message rather than topics to cover at length", () => {
    // This arrives as the prompt the message is written from, so a refusal that
    // named what to cover and nothing about size would be the last word on it.
    expect(NO_MESSAGE_REFUSAL).toContain("the outcome in a sentence");
    expect(NO_MESSAGE_REFUSAL).toContain("a link to where the detail lives");
    expect(NO_MESSAGE_REFUSAL).toContain("Do not restate what you linked");
  });
});

describe("stopHookResponseOf", () => {
  test("blocks with a non-empty reason, which codex requires", () => {
    const response = stopHookResponseOf(decided(claudePayload, false));
    expect(response.decision).toBe("block");
    expect(response.reason?.length).toBeGreaterThan(0);
    expect(response.reason).toBe(NO_MESSAGE_REFUSAL);
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

describe("messageMarkerPath", () => {
  test("defaults to the run directory inside the container", () => {
    expect(messageMarkerPath({})).toBe("/run/message-posted");
  });

  test("takes the override when one is set", () => {
    expect(
      messageMarkerPath({ [MESSAGE_MARKER_ENV_VAR]: " /tmp/run-9/marker " })
    ).toBe("/tmp/run-9/marker");
  });

  test("treats a blank override as unset", () => {
    expect(messageMarkerPath({ [MESSAGE_MARKER_ENV_VAR]: "  " })).toBe(
      "/run/message-posted"
    );
  });

  test("sits beside the event log of whichever layout is asked", () => {
    expect(
      messageMarkerPathOf({
        eventLogPath: "/data/runs/r1/events.jsonl",
        runDir: "/data/runs/r1",
      })
    ).toBe("/data/runs/r1/message-posted");
  });
});

describe("messageRuleApplies", () => {
  test("holds for a turn that has a task to post on", () => {
    expect(
      messageRuleApplies({
        taskId: TaskId.make("019fbfd0-0000-7000-8000-0000000000bb"),
      })
    ).toBe(true);
  });

  test("does not hold for a manager turn, which has no card", () => {
    expect(messageRuleApplies({ taskId: null })).toBe(false);
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

/**
 * The executable, not the rule.
 *
 * Everything above decides from values already in hand. What is left is the
 * part that turns a pipe into those values, and it is the part that broke: an
 * `import process from "node:process"` made `process.stdin` yield no chunks at
 * all when the parent was another Bun process, so the payload read as
 * unparseable and the hook — which fails open at every step, on purpose — sent
 * `{continue:true}` to every turn. Nothing was thrown and nothing was logged.
 * The rule was never wrong; it was never asked.
 *
 * So this drives the script the way a harness does, over a real pipe, and
 * asserts the answer rather than the reasoning. It is slow next to the tests
 * above and it is the only one that would have caught this.
 */
describe("the hook as a process", () => {
  const script = new URL("../scripts/stop-hook.ts", import.meta.url).pathname;

  /** One run of the script, given a payload on stdin and a marker path. */
  const ask = async (options: {
    readonly markerPath: string;
    readonly payload: Readonly<Record<string, unknown>>;
  }) => {
    const child = spawn(["bun", script], {
      env: { ...process.env, [MESSAGE_MARKER_ENV_VAR]: options.markerPath },
      stdin: new TextEncoder().encode(JSON.stringify(options.payload)),
      stdout: "pipe",
    });
    const answer = await new Response(child.stdout).text();
    await child.exited;
    return JSON.parse(answer) as Record<string, unknown>;
  };

  /** A path nothing has created, so the marker is absent rather than stale. */
  const absentMarker = join(tmpdir(), "atm-no-such-run", MESSAGE_MARKER_FILE);

  test("refuses a first ending with no message posted", async () => {
    const answer = await ask({
      markerPath: absentMarker,
      payload: claudePayload,
    });
    expect(answer.decision).toBe("block");
    expect(answer.reason).toBe(NO_MESSAGE_REFUSAL);
  });

  test("allows the ending once the marker is there", async () => {
    const markerPath = join(
      mkdtempSync(join(tmpdir(), "atm-stop-hook-")),
      MESSAGE_MARKER_FILE
    );
    writeFileSync(markerPath, "");
    try {
      expect(await ask({ markerPath, payload: claudePayload })).toEqual(
        ALLOW_TURN_END
      );
    } finally {
      rmSync(markerPath, { force: true });
    }
  });

  /**
   * The bundle, which is the hook every container actually runs — the script
   * above is only for a run outside one. Worth its own case because the two
   * disagreed: the same stdin read that worked in the script returned nothing
   * at all once bundled, so testing one proved nothing about the other.
   *
   * Skipped rather than failed when the bundle is absent, since it is a build
   * artifact and not every checkout has run `entrypoint:build`.
   */
  test("the bundled entrypoint refuses on the same terms", async () => {
    const bundle = join(
      import.meta.dir,
      "../../../.data/bin",
      ENTRYPOINT_BUNDLE_FILE
    );
    if (!existsSync(bundle)) {
      return;
    }
    const child = spawn(["bun", bundle, STOP_HOOK_FLAG], {
      env: { ...process.env, [MESSAGE_MARKER_ENV_VAR]: absentMarker },
      stdin: new TextEncoder().encode(JSON.stringify(claudePayload)),
      stdout: "pipe",
    });
    const answer = JSON.parse(
      await new Response(child.stdout).text()
    ) as Record<string, unknown>;
    await child.exited;
    expect(answer.decision).toBe("block");
  });

  test("allows rather than wedges when stdin holds nothing it can read", async () => {
    const child = spawn(["bun", script], {
      env: { ...process.env, [MESSAGE_MARKER_ENV_VAR]: absentMarker },
      stdin: new TextEncoder().encode("not json"),
      stdout: "pipe",
    });
    const answer = await new Response(child.stdout).text();
    await child.exited;
    expect(JSON.parse(answer)).toEqual(ALLOW_TURN_END);
  });
});
