/**
 * What the compiler cannot say about starting and ending a Claude turn.
 *
 * Two pure decisions carry real consequences and neither is visible in a type.
 * What the subprocess is handed: point `CLAUDE_CONFIG_DIR` at the wrong place
 * and every run shares one credential store, refreshing tokens over each other
 * until they all fail at once. And what a thrown value is named: the
 * classification decides whether the orchestrator retries in a minute, waits
 * for a window to roll over, or stops until a human logs in again.
 */

import { describe, expect, test } from "bun:test";
import { AbortError } from "@anthropic-ai/claude-agent-sdk";
import { buildQuery, harnessErrorOf } from "./claude";
import { DEFAULT_CLAUDE_SETTINGS } from "./claude-settings";
import type { RunOptions } from "./provider";

const RUN_DIR = "/run";

const runOptions = (overrides: Partial<RunOptions> = {}): RunOptions => ({
  agentHomeDir: `${RUN_DIR}/agent-home/claude`,
  effort: null,
  env: {},
  model: null,
  prompt: "ship it",
  resumeSessionId: null,
  runId: null,
  signal: null,
  taskId: null,
  workspaceDir: `${RUN_DIR}/workspace`,
  ...overrides,
});

const queryFor = (overrides: Partial<RunOptions> = {}) =>
  buildQuery({
    abortController: new AbortController(),
    onStderr: () => {
      // The tail is only read when something throws; nothing does here.
    },
    options: runOptions(overrides),
    settings: DEFAULT_CLAUDE_SETTINGS,
  });

describe("buildQuery", () => {
  test("points the config directory at this run's own claude home", () => {
    expect(queryFor().options.env?.CLAUDE_CONFIG_DIR).toBe(
      `${RUN_DIR}/agent-home/claude`
    );
  });

  test("runs in the workspace, never in the agent home", () => {
    expect(queryFor().options.cwd).toBe(`${RUN_DIR}/workspace`);
  });

  test("strips an inherited api key so the run stays on the subscription", () => {
    const previous = process.env.ANTHROPIC_API_KEY;
    process.env.ANTHROPIC_API_KEY = "sk-ant-inherited";
    try {
      expect(queryFor().options.env?.ANTHROPIC_API_KEY).toBeUndefined();
    } finally {
      if (previous === undefined) {
        Reflect.deleteProperty(process.env, "ANTHROPIC_API_KEY");
      } else {
        process.env.ANTHROPIC_API_KEY = previous;
      }
    }
  });

  test("lets the caller put a key back, but never the config directory", () => {
    const { env } = queryFor({
      env: {
        ANTHROPIC_API_KEY: "sk-ant-deliberate",
        CLAUDE_CONFIG_DIR: "/somewhere/else",
      },
    }).options;
    expect(env?.ANTHROPIC_API_KEY).toBe("sk-ant-deliberate");
    expect(env?.CLAUDE_CONFIG_DIR).toBe(`${RUN_DIR}/agent-home/claude`);
  });

  test("omits model and resume rather than sending a null through", () => {
    const { options } = queryFor();
    expect("model" in options).toBe(false);
    expect("resume" in options).toBe(false);
  });

  test("resumes the provider's own session when given one", () => {
    expect(queryFor({ resumeSessionId: "sess-9" }).options.resume).toBe(
      "sess-9"
    );
  });

  test("falls back to the default effort when the caller names a bad one", () => {
    expect(queryFor({ effort: "ultra" }).options.effort).toBe("high");
    expect(queryFor({ effort: "max" }).options.effort).toBe("max");
  });

  test("loads project settings, which is what reads a repository's CLAUDE.md", () => {
    expect(queryFor().options.settingSources).toContain("project");
  });

  test("carries the prompt through untouched", () => {
    expect(queryFor().prompt).toBe("ship it");
  });
});

describe("harnessErrorOf", () => {
  test("an abort is a stop, not a crash", () => {
    expect(harnessErrorOf(new AbortError("aborted by user"), "")).toMatchObject(
      { _tag: "Harness.Interrupted", reason: "stopped" }
    );
  });

  test("a non-zero exit keeps the code and the stderr behind it", () => {
    expect(
      harnessErrorOf(
        new Error("Claude Code process exited with code 2. stderr: bad flag"),
        "bad flag"
      )
    ).toMatchObject({
      _tag: "Harness.ProcessFailed",
      exitCode: 2,
      stderr: "bad flag",
    });
  });

  test("a rate limit is named from stderr, and invents no backoff", () => {
    expect(
      harnessErrorOf(new Error("stream closed"), "429 rate limit exceeded")
    ).toMatchObject({ _tag: "Harness.RateLimited", retryAfterMs: null });
  });

  test("a refused login is its own class, because waiting never fixes it", () => {
    expect(harnessErrorOf(new Error("invalid api key"), "")).toMatchObject({
      _tag: "Harness.Unauthenticated",
    });
  });

  test("a request that never came back is a network failure, not a cap", () => {
    // The harness enforces no timeout of its own, so naming this `TimedOut`
    // would print milliseconds nobody set.
    expect(harnessErrorOf(new Error("request timed out"), "")).toMatchObject({
      _tag: "Harness.NetworkFailed",
    });
  });

  test("anything unrecognized keeps its cause rather than guessing", () => {
    const thrown = { weird: true };
    expect(harnessErrorOf(thrown, "")).toMatchObject({
      _tag: "Harness.ProviderCrashed",
      cause: thrown,
    });
  });

  test("redacts a secret the provider printed into its own message", () => {
    const error = harnessErrorOf(
      new Error("upstream said Bearer sk-live-abc123def456"),
      ""
    );
    expect(JSON.stringify(error)).not.toContain("sk-live-abc123def456");
  });
});
