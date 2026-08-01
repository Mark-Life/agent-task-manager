/**
 * The settings layer every Claude run starts from, and how a caller's override
 * lands on top of it.
 *
 * `options.settings` is the highest-priority user-controlled tier the SDK has,
 * so whatever is written here beats the `settings.json` sitting in the run's
 * agent home. That is the point: the agent home is seeded from a logged-in
 * account, so a worker container inherits that account's cloud connectors and
 * remote-control surfaces unless something turns them off, and this file is
 * that something.
 *
 * Nothing here is about capability. A worker is meant to read, write and run
 * commands in its checkout. What it is not meant to do is anything that needs a
 * human on the other end — it has no one to ask — or that reaches a surface a
 * throwaway container has no business on.
 */

import type {
  EffortLevel,
  SettingSource,
  Settings,
} from "@anthropic-ai/claude-agent-sdk";
import { stopHookCommand } from "./stop-hook";

/**
 * Reasoning effort levels, in ascending order. Passed per run through
 * `options.effort` rather than through the settings file, because `max` is
 * session-scoped and the persisted `Settings.effortLevel` cannot express it.
 */
export const EFFORT_LEVELS = [
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
] as const satisfies readonly EffortLevel[];

/**
 * What a run uses when the caller selects nothing. High rather than the
 * cheapest: a task worker is judged on the diff it leaves behind, and the
 * saving from thinking less is a rounding error against a wrong one.
 */
export const DEFAULT_CLAUDE_EFFORT = "high" satisfies EffortLevel;

/** Narrows a caller's free-text effort to one the SDK accepts. Pure. */
export const effortOf = (value: string | null) =>
  EFFORT_LEVELS.find((level) => level === value);

/**
 * Which settings files on disk the run reads underneath our own layer.
 *
 * `project` is load-bearing and not merely permitted: it is what makes the CLI
 * read the repository's `CLAUDE.md`, which is the whole of a project's standing
 * instructions to the agent. `user` resolves inside the run's own agent home,
 * so it is our copy rather than an operator's.
 */
export const CLAUDE_SETTING_SOURCES = [
  "user",
  "project",
  "local",
] as const satisfies readonly SettingSource[];

/**
 * Tools denied on every run.
 *
 * Two groups, for two different reasons. The first wants a human in the loop
 * and there is none — a headless worker that asks a question stalls until its
 * cap, and the turn dies having done nothing. The second reaches out of the
 * container: notifications, remote triggers and cron all outlive the run that
 * created them, so a container that is about to be deleted must not be able to
 * schedule anything.
 */
export const DENIED_TOOLS: readonly string[] = [
  "AskUserQuestion",
  "CronCreate",
  "CronDelete",
  "CronList",
  "PushNotification",
  "RemoteTrigger",
  "ScheduleWakeup",
  "SendMessage",
];

/**
 * The base settings for a worker run.
 *
 * Bundled skills stay on: a coding agent's skills are most of why the harness
 * is worth running, and the context they cost is the context they earn. What
 * goes off is everything that leaves the container. The claude.ai connectors
 * are the sharpest of them — they are fetched from the logged-in account, so
 * without this a task about one repository arrives holding the operator's mail
 * and documents.
 */
export const DEFAULT_CLAUDE_SETTINGS: Settings = {
  disableArtifact: true,
  disableClaudeAiConnectors: true,
  disableRemoteControl: true,
  permissions: { deny: [...DENIED_TOOLS] },
};

/**
 * The event the stop hook is registered on. Only `Stop`: `SubagentStop` fires
 * when a delegated subagent finishes, and refusing that would hold a subagent
 * open over a comment the parent turn has not had a chance to post yet.
 */
const STOP_HOOK_EVENT = "Stop";

/**
 * Registers the run's stop-hook command, or nothing when the environment names
 * none.
 *
 * Nothing is what an unsandboxed run gets, and it is a real configuration rather
 * than a broken one: the command is a path inside the image, so only the party
 * that built the image can name it. A run without it simply ends when the model
 * decides to, and the orchestrator's own fallback comment covers the same rule
 * from the other side.
 *
 * No `matcher` is set, because a stop event has no tool name to match on and a
 * matcher that never matches is a hook that silently never fires.
 */
export const stopHookSettings = (
  env: Readonly<Record<string, string | undefined>>
): Settings => {
  const command = stopHookCommand(env);
  return command === null
    ? {}
    : {
        hooks: {
          [STOP_HOOK_EVENT]: [{ hooks: [{ command, type: "command" }] }],
        },
      };
};

/**
 * Lays an override over the base settings. Top-level keys replace wholesale;
 * `permissions` merges one level deep, so an override can redefine `deny`
 * without silently dropping an `allow` or `ask` list it never mentioned.
 * Clearing a default is explicit — `{ permissions: { deny: [] } }`.
 */
export const mergeClaudeSettings = (
  base: Settings,
  override: Settings
): Settings => ({
  ...base,
  ...override,
  ...(base.permissions || override.permissions
    ? { permissions: { ...base.permissions, ...override.permissions } }
    : {}),
});

/**
 * Reads a settings override supplied as JSON, or null when the text is not a
 * JSON object.
 *
 * Null rather than a throw or a silent fallback, because the caller is the only
 * one who can choose between refusing the run and running on the defaults, and
 * quietly running an agent under a permission set nobody asked for is the one
 * option that must not be the default.
 */
export const parseClaudeSettings = (json: string): Settings | null => {
  try {
    const parsed: unknown = JSON.parse(json);
    return typeof parsed === "object" &&
      parsed !== null &&
      !Array.isArray(parsed)
      ? (parsed as Settings)
      : null;
  } catch {
    return null;
  }
};
