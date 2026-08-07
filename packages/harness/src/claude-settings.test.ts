/**
 * What the compiler cannot say about the settings layer.
 *
 * The defaults are the only thing standing between a worker container and the
 * surfaces its logged-in account can reach, so each one is asserted by name:
 * a key silently dropped in a refactor is a connector quietly back on. The
 * merge and the parse are the two places a caller's override can go wrong
 * without anyone noticing — a `deny` list replaced by an `allow` that was never
 * written, or a typo'd JSON blob read as an empty object.
 */

import { describe, expect, test } from "bun:test";
import { ConfigProvider, Effect } from "effect";
import {
  CLAUDE_SETTINGS_ENV_VAR,
  DEFAULT_CLAUDE_EFFORT,
  DEFAULT_CLAUDE_SETTINGS,
  DENIED_TOOLS,
  effortOf,
  mergeClaudeSettings,
  parseClaudeSettings,
  readClaudeSettings,
} from "./claude-settings";

describe("DEFAULT_CLAUDE_SETTINGS", () => {
  test("closes every surface that leaves the container", () => {
    expect(DEFAULT_CLAUDE_SETTINGS.disableClaudeAiConnectors).toBe(true);
    expect(DEFAULT_CLAUDE_SETTINGS.disableRemoteControl).toBe(true);
    expect(DEFAULT_CLAUDE_SETTINGS.disableArtifact).toBe(true);
  });

  test("denies the tools that need a human on the other end", () => {
    const deny = DEFAULT_CLAUDE_SETTINGS.permissions?.deny ?? [];
    expect(deny).toContain("AskUserQuestion");
    expect(deny).toEqual([...DENIED_TOOLS]);
  });

  test("denies plan mode, which ends a headless turn with a proposal", () => {
    const deny = DEFAULT_CLAUDE_SETTINGS.permissions?.deny ?? [];
    expect(deny).toContain("EnterPlanMode");
    expect(deny).toContain("ExitPlanMode");
  });

  test("drops the shipped skills, and leaves workflows alone", () => {
    expect(DEFAULT_CLAUDE_SETTINGS.disableBundledSkills).toBe(true);
    expect(DEFAULT_CLAUDE_SETTINGS.disableWorkflows).toBeUndefined();
  });
});

describe("effortOf", () => {
  test("passes a level the SDK accepts", () => {
    expect(effortOf("xhigh")).toBe("xhigh");
    expect(effortOf("max")).toBe("max");
  });

  test("refuses anything else, so the caller falls back to the default", () => {
    expect(effortOf("ultra")).toBeUndefined();
    expect(effortOf(null)).toBeUndefined();
    expect(effortOf("")).toBeUndefined();
  });

  test("names a default the SDK accepts", () => {
    expect(effortOf(DEFAULT_CLAUDE_EFFORT)).toBe(DEFAULT_CLAUDE_EFFORT);
  });
});

describe("mergeClaudeSettings", () => {
  test("a top-level override replaces wholesale", () => {
    const merged = mergeClaudeSettings(DEFAULT_CLAUDE_SETTINGS, {
      disableArtifact: false,
    });
    expect(merged.disableArtifact).toBe(false);
    expect(merged.disableRemoteControl).toBe(true);
  });

  test("permissions merge one level deep, so deny can be redefined alone", () => {
    const merged = mergeClaudeSettings(
      { permissions: { allow: ["Bash(git *)"], deny: ["AskUserQuestion"] } },
      { permissions: { deny: [] } }
    );
    expect(merged.permissions?.deny).toEqual([]);
    expect(merged.permissions?.allow).toEqual(["Bash(git *)"]);
  });

  test("an override that mentions no permissions keeps the base ones", () => {
    const merged = mergeClaudeSettings(DEFAULT_CLAUDE_SETTINGS, {
      model: "opus",
    });
    expect(merged.permissions?.deny).toEqual([...DENIED_TOOLS]);
  });
});

const settingsFrom = (env: Record<string, string>) =>
  Effect.runPromise(
    readClaudeSettings.pipe(
      Effect.provide(ConfigProvider.layer(ConfigProvider.fromUnknown(env))),
      Effect.exit
    )
  );

describe("readClaudeSettings", () => {
  test("an unset overlay is the hardened defaults", async () => {
    const exit = await settingsFrom({});
    expect(exit._tag).toBe("Success");
    if (exit._tag === "Success") {
      expect(exit.value).toEqual(DEFAULT_CLAUDE_SETTINGS);
    }
  });

  test("a blank overlay is unset, which is how every env file ships it", async () => {
    const exit = await settingsFrom({ [CLAUDE_SETTINGS_ENV_VAR]: "   " });
    expect(exit._tag).toBe("Success");
    if (exit._tag === "Success") {
      expect(exit.value).toEqual(DEFAULT_CLAUDE_SETTINGS);
    }
  });

  test("an overlay lands on top of the defaults, not instead of them", async () => {
    const exit = await settingsFrom({
      [CLAUDE_SETTINGS_ENV_VAR]: '{"permissions":{"deny":["NotebookEdit"]}}',
    });
    expect(exit._tag).toBe("Success");
    if (exit._tag === "Success") {
      expect(exit.value.permissions?.deny).toEqual(["NotebookEdit"]);
      expect(exit.value.disableBundledSkills).toBe(true);
      expect(exit.value.disableClaudeAiConnectors).toBe(true);
    }
  });

  test("an overlay that is not a JSON object fails rather than falls back", async () => {
    const exit = await settingsFrom({ [CLAUDE_SETTINGS_ENV_VAR]: "{not json" });
    expect(exit._tag).toBe("Failure");
  });
});

describe("parseClaudeSettings", () => {
  test("reads a settings object", () => {
    expect(parseClaudeSettings('{"model":"opus"}')).toEqual({ model: "opus" });
  });

  test("refuses text that is not a JSON object", () => {
    expect(parseClaudeSettings("{not json")).toBeNull();
    expect(parseClaudeSettings("[]")).toBeNull();
    expect(parseClaudeSettings("null")).toBeNull();
    expect(parseClaudeSettings('"opus"')).toBeNull();
  });
});
