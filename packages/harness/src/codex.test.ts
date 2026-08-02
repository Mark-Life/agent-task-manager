import { describe, expect, test } from "bun:test";
import { codexArgs, codexEnv } from "./codex";
import type { RunOptions } from "./provider";

const options: RunOptions = {
  agentHomeDir: "/run/agent-home/codex",
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

describe("codexArgs", () => {
  test("carries the approvals and hook-trust bypasses on a fresh turn", () => {
    const args = codexArgs(options);
    expect(args).toContain("--dangerously-bypass-approvals-and-sandbox");
    expect(args).toContain("--dangerously-bypass-hook-trust");
    expect(args).toContain("--json");
    expect(args.at(-1)).toBe("-");
    expect(args).not.toContain("resume");
  });

  test("carries the same bypasses on a resume", () => {
    const args = codexArgs({ ...options, resumeSessionId: "thread-9" });
    expect(args).toContain("--dangerously-bypass-hook-trust");
    expect(args.slice(-3)).toEqual(["resume", "thread-9", "-"]);
    // Every flag has to precede the subcommand or it belongs to `resume`.
    expect(args.indexOf("--cd")).toBeLessThan(args.indexOf("resume"));
  });

  test("passes model and effort only when the caller chose one", () => {
    expect(codexArgs(options)).not.toContain("--model");
    const chosen = codexArgs({
      ...options,
      effort: "high",
      model: "gpt-5.6-sol",
    });
    expect(chosen).toContain("--model");
    expect(chosen).toContain('model_reasoning_effort="high"');
  });

  test("never puts the prompt in the argument list", () => {
    expect(codexArgs(options).join(" ")).not.toContain(options.prompt);
  });
});

describe("codexEnv", () => {
  test("points CODEX_HOME at this run's own agent home", () => {
    expect(codexEnv(options).CODEX_HOME).toBe("/run/agent-home/codex");
  });

  test("wins over a caller that tried to set it", () => {
    const env = codexEnv({
      ...options,
      env: { CODEX_HOME: "/home/user/.codex" },
    });
    expect(env.CODEX_HOME).toBe("/run/agent-home/codex");
  });

  test("unsets the nested-agent marker", () => {
    expect(
      codexEnv({ ...options, env: { CLAUDECODE: "1" } }).CLAUDECODE
    ).toBeUndefined();
  });
});
