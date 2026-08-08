import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BunFileSystem } from "@effect/platform-bun";
import { TOML } from "bun";
import { Effect } from "effect";
import {
  CODEX_PROJECT_DOC_MAX_BYTES,
  codexConfigPath,
  codexConfigToml,
  writeCodexConfig,
} from "./codex-config";
import { EXECUTOR_KEY_ENV_VAR, makeExecutorMcp } from "./executor-mcp";
import { ATM_ROOT_MARKER } from "./paths";

const EXECUTOR_KEY = "sk-executor-secret";

const executor = makeExecutorMcp({
  key: EXECUTOR_KEY,
  url: "https://executor.sh/org_1/mcp",
});

/** The rendered file, read back through a real TOML parser rather than a regex. */
const parsed = (from: ReturnType<typeof codexConfigToml>) =>
  TOML.parse(from) as Record<string, unknown>;

/**
 * What this file defends: a Codex run that reads one `AGENTS.md`.
 *
 * Codex stops its upward walk at the nearest ancestor holding a
 * `project_root_markers` entry, so every one of these cases is the difference
 * between a run given its whole scope tree and a run given its checkout.
 */
describe("codexConfigToml", () => {
  test("points the root marker at the top of the tree and nowhere else", () => {
    // Replaced, not extended. The walk takes the nearest match and a checkout's
    // own `.git` sits below every scope, so a list holding both would stop
    // exactly where the default does.
    expect(parsed(codexConfigToml(null)).project_root_markers).toEqual([
      ATM_ROOT_MARKER,
    ]);
    expect(codexConfigToml(null)).not.toContain(".git");
  });

  test("raises the project doc cap above the default that truncates root first", () => {
    expect(parsed(codexConfigToml(null)).project_doc_max_bytes).toBe(
      CODEX_PROJECT_DOC_MAX_BYTES
    );
    expect(CODEX_PROJECT_DOC_MAX_BYTES).toBeGreaterThan(32 * 1024);
  });

  test("says both of them for an install that configured no executor", () => {
    // The bug: the config was written as a side effect of wiring Executor, so
    // an install without one wrote no file and lost the tree on this provider.
    expect(parsed(codexConfigToml(null))).toEqual({
      project_doc_max_bytes: CODEX_PROJECT_DOC_MAX_BYTES,
      project_root_markers: [ATM_ROOT_MARKER],
    });
  });

  test("merges executor's server without losing the two settings", () => {
    expect(parsed(codexConfigToml(executor))).toEqual({
      mcp_servers: {
        executor: {
          bearer_token_env_var: EXECUTOR_KEY_ENV_VAR,
          url: "https://executor.sh/org_1/mcp",
        },
      },
      project_doc_max_bytes: CODEX_PROJECT_DOC_MAX_BYTES,
      project_root_markers: [ATM_ROOT_MARKER],
    });
  });

  test("names the variable holding the token, never the token", () => {
    expect(codexConfigToml(executor)).not.toContain(EXECUTOR_KEY);
  });

  test("puts the bare keys before the first table, as toml requires", () => {
    const rendered = codexConfigToml(executor);
    expect(rendered.indexOf("project_root_markers")).toBeLessThan(
      rendered.indexOf("[mcp_servers")
    );
  });
});

describe("writeCodexConfig", () => {
  let root = "";

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "codex-config-"));
  });

  afterEach(() => {
    rmSync(root, { force: true, recursive: true });
  });

  const write = (agentHomeDir: string) =>
    Effect.runPromise(
      writeCodexConfig({ agentHomeDir, executor: null }).pipe(
        Effect.provide(BunFileSystem.layer)
      )
    );

  test("writes the file into an agent home that does not exist yet", async () => {
    const agentHomeDir = join(root, "codex");
    await write(agentHomeDir);
    expect(existsSync(agentHomeDir)).toBe(true);
    expect(readFileSync(codexConfigPath(agentHomeDir), "utf8")).toBe(
      codexConfigToml(null)
    );
  });

  test("writes the same bytes twice, which is what makes a shared home safe", async () => {
    // Every run rewrites this file in a directory every other container is
    // reading. Idempotent bytes are the whole of the argument that it is safe.
    const agentHomeDir = join(root, "codex");
    await write(agentHomeDir);
    const first = readFileSync(codexConfigPath(agentHomeDir), "utf8");
    await write(agentHomeDir);
    expect(readFileSync(codexConfigPath(agentHomeDir), "utf8")).toBe(first);
  });
});
