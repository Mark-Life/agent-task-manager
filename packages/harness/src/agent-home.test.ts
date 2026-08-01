import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BunFileSystem } from "@effect/platform-bun";
import { newRunId } from "@workspace/domain";
import { Effect } from "effect";
import type { FileSystem } from "effect/FileSystem";
import {
  CredentialsMissing,
  prepareAgentHome,
  pruneClaudeConfig,
  teardownAgentHome,
} from "./agent-home";
import { hostRunLayout } from "./paths";

let root: string;
let dataRoot: string;
let source: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "agent-home-"));
  dataRoot = join(root, "data");
  source = join(root, "source");
  mkdirSync(source, { recursive: true });
});

afterEach(() => {
  rmSync(root, { force: true, recursive: true });
});

const run = <A, E>(program: Effect.Effect<A, E, FileSystem>) =>
  Effect.runPromise(program.pipe(Effect.provide(BunFileSystem.layer)));

describe("pruneClaudeConfig", () => {
  test("keeps the account identity and drops everything else", () => {
    const pruned = JSON.parse(
      pruneClaudeConfig(
        JSON.stringify({
          hasCompletedOnboarding: true,
          oauthAccount: { emailAddress: "operator@example.com" },
          projects: { "/Users/me/secret-client": { history: ["a prompt"] } },
          tipsHistory: { tip: 1 },
          userID: "user-1",
        })
      )
    );
    expect(Object.keys(pruned).sort()).toEqual([
      "hasCompletedOnboarding",
      "oauthAccount",
      "userID",
    ]);
  });

  test("never carries a project path or a prompt", () => {
    const pruned = pruneClaudeConfig(
      JSON.stringify({
        projects: { "/Users/me/secret-client": { history: ["a prompt"] } },
      })
    );
    expect(pruned).not.toContain("secret-client");
    expect(pruned).not.toContain("a prompt");
  });

  test("answers an empty config for a file it cannot parse", () => {
    expect(pruneClaudeConfig("{ truncated")).toBe("{}");
    expect(pruneClaudeConfig("[]")).toBe("{}");
  });
});

describe("prepareAgentHome", () => {
  test("copies only the named credential files, not the directory", async () => {
    writeFileSync(join(source, "auth.json"), '{"tokens":{"access_token":"t"}}');
    writeFileSync(join(source, "config.toml"), "[projects]\n");
    mkdirSync(join(source, "sessions", "2026"), { recursive: true });
    writeFileSync(join(source, "sessions", "2026", "rollout.jsonl"), "{}\n");

    const report = await run(
      prepareAgentHome({
        layout: hostRunLayout({ dataRoot, runId: newRunId() }),
        provider: "codex",
        sourceDir: source,
      })
    );

    expect(report.seeded).toEqual(["auth.json"]);
    expect(report.missing).toEqual([]);
    expect(existsSync(join(report.agentHomeDir, "auth.json"))).toBe(true);
    expect(existsSync(join(report.agentHomeDir, "config.toml"))).toBe(false);
    expect(existsSync(join(report.agentHomeDir, "sessions"))).toBe(false);
  });

  test("points the provider at the copy through its own variable", async () => {
    writeFileSync(join(source, "auth.json"), "{}");
    const report = await run(
      prepareAgentHome({
        layout: hostRunLayout({ dataRoot, runId: newRunId() }),
        provider: "codex",
        sourceDir: source,
      })
    );
    expect(report.env.CODEX_HOME).toBe(report.agentHomeDir);
  });

  test("prunes the Claude config on the way in", async () => {
    writeFileSync(join(source, ".credentials.json"), '{"claudeAiOauth":{}}');
    writeFileSync(
      join(source, ".claude.json"),
      JSON.stringify({ projects: { "/secret": {} }, userID: "user-1" })
    );

    const report = await run(
      prepareAgentHome({
        layout: hostRunLayout({ dataRoot, runId: newRunId() }),
        provider: "claude",
        sourceDir: source,
      })
    );

    expect(report.seeded.sort()).toEqual([".claude.json", ".credentials.json"]);
    expect(
      readFileSync(join(report.agentHomeDir, ".claude.json"), "utf8")
    ).toBe('{"userID":"user-1"}');
  });

  test("reports an optional file the host never had", async () => {
    writeFileSync(join(source, ".claude.json"), "{}");
    const report = await run(
      prepareAgentHome({
        layout: hostRunLayout({ dataRoot, runId: newRunId() }),
        provider: "claude",
        sourceDir: source,
      })
    );
    expect(report.missing).toEqual([".credentials.json"]);
  });

  test("fails before the container starts when the login is absent", async () => {
    const failure = await run(
      prepareAgentHome({
        layout: hostRunLayout({ dataRoot, runId: newRunId() }),
        provider: "codex",
        sourceDir: source,
      }).pipe(Effect.flip)
    );
    expect(failure).toBeInstanceOf(CredentialsMissing);
  });
});

describe("teardownAgentHome", () => {
  test("removes the run home and succeeds when there is none", async () => {
    writeFileSync(join(source, "auth.json"), "{}");
    const runLayout = hostRunLayout({ dataRoot, runId: newRunId() });
    const report = await run(
      prepareAgentHome({
        layout: runLayout,
        provider: "codex",
        sourceDir: source,
      })
    );
    expect(existsSync(report.agentHomeDir)).toBe(true);

    await run(teardownAgentHome(runLayout));
    expect(existsSync(runLayout.agentHomeDir)).toBe(false);

    await run(teardownAgentHome(runLayout));
  });
});
