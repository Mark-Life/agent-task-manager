import { describe, expect, test } from "bun:test";
import { piArgs, piEnv, piProvider } from "./pi";
import type { RunOptions } from "./provider";

const options: RunOptions = {
  agentHomeDir: "/run/agent-home/pi",
  effort: null,
  env: { PATH: "/usr/bin" },
  mcpServers: null,
  model: null,
  prompt: "ship it",
  resumeSessionId: null,
  runId: null,
  signal: null,
  taskId: null,
  workspaceDir: "/run/workspace",
};

describe("piArgs", () => {
  test("asks for the event stream this harness parses", () => {
    expect(piArgs(options)).toEqual(["--mode", "json"]);
  });

  test("passes model and thinking level only when the caller chose one", () => {
    expect(piArgs(options)).not.toContain("--model");
    expect(piArgs(options)).not.toContain("--thinking");
    const chosen = piArgs({
      ...options,
      effort: "off",
      model: "openrouter/qwen/qwen3-coder",
    });
    expect(
      chosen.slice(chosen.indexOf("--model"), 2 + chosen.indexOf("--model"))
    ).toEqual(["--model", "openrouter/qwen/qwen3-coder"]);
    expect(chosen).toContain("--thinking");
    expect(chosen).toContain("off");
  });

  test("resumes by the same id the transcript is filed under", () => {
    const args = piArgs({ ...options, resumeSessionId: "01a0476e-042e" });
    expect(args.slice(-2)).toEqual(["--session", "01a0476e-042e"]);
  });

  test("never puts the prompt in the argument list", () => {
    // Pi merges piped stdin into the initial prompt, so the prompt travels
    // there — argv is world-readable and a prompt quotes a task.
    expect(
      piArgs({ ...options, prompt: "a secret brief" }).join(" ")
    ).not.toContain("secret");
  });
});

describe("piEnv", () => {
  test("points PI_CODING_AGENT_DIR at this run's own agent home", () => {
    expect(piEnv(options).PI_CODING_AGENT_DIR).toBe("/run/agent-home/pi");
  });

  test("wins over a caller that tried to set it", () => {
    const env = piEnv({
      ...options,
      env: { PI_CODING_AGENT_DIR: "/home/user/.pi/agent" },
    });
    expect(env.PI_CODING_AGENT_DIR).toBe("/run/agent-home/pi");
  });

  test("sets the headless hygiene defaults", () => {
    const env = piEnv(options);
    expect(env.PI_SKIP_VERSION_CHECK).toBe("1");
    expect(env.PI_TELEMETRY).toBe("0");
  });

  test("lets a host turn the hygiene defaults back off", () => {
    expect(piEnv({ ...options, env: { PI_TELEMETRY: "1" } }).PI_TELEMETRY).toBe(
      "1"
    );
  });

  test("leaves the model catalog reachable", () => {
    // `PI_OFFLINE` would also stop the catalog refresh, and the catalog is the
    // reason this provider is in the table at all.
    expect(piEnv(options).PI_OFFLINE).toBeUndefined();
  });
});

describe("piProvider", () => {
  test("claims no subagents, because Pi has none", () => {
    expect(piProvider.capabilities.subagents).toBe(false);
  });

  test("claims no stop hook, because Pi registers none", () => {
    expect(piProvider.capabilities.hooks).toBe(false);
  });

  test("claims a cost, which is real money on the operator's own key", () => {
    expect(piProvider.capabilities.cost).toBe(true);
  });

  test("names no default effort, because the agent home's settings decide", () => {
    expect(piProvider.defaultEffort).toBeNull();
  });

  test("offers no compiled-in model list", () => {
    // The catalog is `models.json` in the agent home plus Pi's own table; a
    // list here would be a stale copy of part of it.
    expect(piProvider.models).toHaveLength(0);
  });
});
