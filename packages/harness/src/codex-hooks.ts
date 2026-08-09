/**
 * The hook definition Codex reads, and where a run's copy of it is written.
 *
 * Claude takes its hooks as part of the settings object the SDK is called with,
 * so registering one costs nothing but a key. Codex takes them from disk: it
 * reads `hooks.json` out of `CODEX_HOME` at startup, so a run whose `CODEX_HOME`
 * is a freshly seeded directory has no hooks at all until something writes that
 * file. Passing the trust-bypass flag without writing it is what "hooks: true"
 * looked like while the rule was in fact unenforced on this provider.
 *
 * The format was established against the installed CLI rather than from
 * documentation — `codex 0.146.0`, empirically, by writing a candidate file into
 * a throwaway `CODEX_HOME` and watching the command run:
 *
 *   { "description": …,
 *     "hooks": { "Stop": [ { "hooks": [ { "type": "command", "command": … } ] } ] } }
 *
 * Event keys are the same PascalCase names Claude uses (`Stop`, `SessionStart`,
 * `PreToolUse`, …). The outer array is matcher groups, whose `matcher` is
 * optional and omitted here for the same reason as on the Claude side: a stop
 * event has no tool name to match on. The command is run through a login shell,
 * so a command line rather than a bare path is what belongs in `command`. The
 * payload Codex writes to that command's stdin is the one `./stop-hook` decodes,
 * `stop_hook_active` included.
 *
 * Written next to `config.toml` rather than into it. Codex accepts either
 * representation and warns when a layer carries both, and `config.toml` in the
 * agent home is rewritten wholesale by the entrypoint when Executor is wired.
 */

import { join } from "node:path";
import { Effect } from "effect";
import { FileSystem } from "effect/FileSystem";
import { stopHookCommand } from "./stop-hook";

/** Codex's hook file, at the root of whichever directory is `CODEX_HOME`. */
export const CODEX_HOOKS_FILE = "hooks.json";

/**
 * The event the hook is registered on. Only `Stop`, matching the Claude side:
 * `SubagentStop` would hold a delegated subagent open over a message the parent
 * turn has not had a chance to post yet.
 */
const STOP_HOOK_EVENT = "Stop";

/** One handler. `command` is the only handler kind Codex currently runs. */
interface CodexCommandHook {
  /** A shell command line; Codex runs it through a login shell. */
  readonly command: string;
  readonly type: "command";
}

/** Handlers sharing a matcher. The matcher is omitted: a stop has nothing to match. */
interface CodexHookMatcherGroup {
  readonly hooks: readonly CodexCommandHook[];
}

/** The whole of `hooks.json`, keyed by Codex's PascalCase event names. */
export interface CodexHooksFile {
  readonly description: string;
  readonly hooks: Readonly<Record<string, readonly CodexHookMatcherGroup[]>>;
}

/** What the file says about itself, wherever Codex lists its hooks. */
const HOOKS_DESCRIPTION = "Agent task manager: a run must post a message.";

/**
 * The hook definition for a run, or null when the environment names no
 * command. Pure.
 *
 * Null is a real configuration and not a broken one, exactly as on the Claude
 * side: the command is a path inside the image, so only a sandboxed run has
 * one, and a run without it ends when the model decides to.
 */
export const codexHooksFile = (
  env: Readonly<Record<string, string | undefined>>
): CodexHooksFile | null => {
  const command = stopHookCommand(env);
  return command === null
    ? null
    : {
        description: HOOKS_DESCRIPTION,
        hooks: {
          [STOP_HOOK_EVENT]: [{ hooks: [{ command, type: "command" }] }],
        },
      };
};

/** Where a run's hook definition goes, given its own `CODEX_HOME`. */
export const codexHooksPath = (agentHomeDir: string) =>
  join(agentHomeDir, CODEX_HOOKS_FILE);

/**
 * Writes the run's hook definition into its `CODEX_HOME`, or does nothing when
 * no command is configured. Answers whether a definition was written, so a
 * caller can say which of the two it got rather than inferring it.
 */
export const writeCodexHooks = Effect.fn("Codex.writeHooks")(function* (input: {
  /** The mounted system-owned `CODEX_HOME`, shared by every run on the host. */
  readonly agentHomeDir: string;
  readonly env: Readonly<Record<string, string | undefined>>;
}) {
  const file = codexHooksFile(input.env);
  if (file === null) {
    return false;
  }
  const fs = yield* FileSystem;
  yield* fs.makeDirectory(input.agentHomeDir, { recursive: true });
  yield* fs.writeFileString(
    codexHooksPath(input.agentHomeDir),
    JSON.stringify(file)
  );
  return true;
});
