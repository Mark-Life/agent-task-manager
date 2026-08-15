/**
 * `config.toml` in a run's `CODEX_HOME`: the two settings that decide how much
 * of the instruction tree Codex reads, and Executor's MCP server when the
 * install has one.
 *
 * Claude needs nothing here. Its own walk up from the working directory has no
 * stop until the filesystem root, so a nested tree of `CLAUDE.md` reaches it
 * with no configuration at all. Codex stops at the nearest ancestor holding a
 * `project_root_markers` entry and reads nothing above it, so without this file
 * the whole nesting is dead on that provider: a run standing in its checkout
 * collects the checkout's own `AGENTS.md` and none of the scopes above it.
 *
 * **The markers are replaced, never extended.** The walk takes the nearest
 * match, and a checkout's own `.git` sits below every scope, so a list holding
 * both {@link ATM_ROOT_MARKER} and `.git` stops exactly where the default does.
 *
 * **They have to be in this file rather than on the command line.** The
 * exec-server config path derives the marker list from the system and user
 * `config.toml` alone and ignores `-c` overrides, so `codex exec -c
 * project_root_markers=...` is accepted, reported nowhere, and not used.
 *
 * Written for every Codex turn rather than only for a turn that has Executor to
 * merge in, which is the bug this file was split out of: the config was a side
 * effect of wiring Executor, so an install with no Executor configured wrote no
 * `config.toml` at all and its Codex runs silently read one `AGENTS.md`.
 *
 * TODO: this is a whole-file write into a directory every other container is
 * reading, and the only thing keeping it safe is that every run writes the same
 * bytes. It holds no secret — `bearer_token_env_var` names the variable rather
 * than carrying the token. The `mcp_servers` half could move to
 * `codex -c mcp_servers.<name>.<field>=<value>`; the two settings above cannot,
 * for the reason given above, so a file has to be written either way.
 */

import { join } from "node:path";
import { Effect } from "effect";
import { FileSystem } from "effect/FileSystem";
import {
  type CodexExecutorConfig,
  codexExecutorConfig,
  type ExecutorMcp,
} from "./executor-mcp";
import { ATM_ROOT_MARKER } from "./paths";

/** Codex's config file, at the root of whichever directory is `CODEX_HOME`. */
export const CODEX_CONFIG_FILE = "config.toml";

/** Where a run's Codex config goes, given its own `CODEX_HOME`. */
export const codexConfigPath = (agentHomeDir: string) =>
  join(agentHomeDir, CODEX_CONFIG_FILE);

/**
 * The combined cap on the project documents one turn is given, in bytes.
 *
 * Raised from Codex's own 32 KiB because that budget is spent root first,
 * across every document collected — so with the workspace, project, task and
 * checkout levels stacked, the first thing truncated is the deepest and most
 * specific document of the four, which is backwards from what the nesting is
 * for. Truncation is silent to a headless caller: the only signal is a
 * `tracing::warn!`, and `codex exec` filters stderr at `error`.
 *
 * There is no upper clamp on the setting. The cost is context, not correctness,
 * and raising it moves the cliff rather than removing it — a warning when a
 * run's instruction files outgrow the original 32 KiB belongs where the person
 * writing them can see it, not in a container.
 */
export const CODEX_PROJECT_DOC_MAX_BYTES = 262_144;

/** Codex's config as its own CLI declares it: a table, and what a table holds. */
type CodexConfigTable = CodexExecutorConfig["config"];
type CodexConfigValue = CodexConfigTable[string];

/**
 * A nested table rather than a scalar. A predicate and not a cast, and it turns
 * away arrays and null as well: `typeof` calls both an object, and neither is a
 * table — one would render as a header over positional keys, the other throws.
 */
const isTable = (
  value: CodexConfigValue | undefined
): value is CodexConfigTable =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/**
 * One server, as a TOML table. Deliberately not a general encoder: the only
 * thing this ever renders is a server's string fields, so a table header and
 * quoted strings is the whole grammar, and a dependency for it would be a
 * dependency inside a container image.
 *
 * Every other kind of value a table can hold is therefore dropped — the day
 * `startup_timeout_sec`, a real Codex setting, is added to
 * {@link codexExecutorConfig}, that number leaves no trace in the rendered
 * file. The type does not prevent it: `CodexOptions["config"]` is a recursive
 * index signature and not a discriminated union, so nothing here can be made
 * exhaustive. Naming the case is the whole of what typing this buys — which is
 * more than the cast it replaced ever admitted.
 */
const serverToml = (name: string, server: CodexConfigTable) => {
  const fields = Object.entries(server)
    .filter(([, value]) => typeof value === "string")
    .map(([key, value]) => `${key} = ${JSON.stringify(value)}`)
    .join("\n");
  return `[mcp_servers.${name}]\n${fields}\n`;
};

/** The `mcp_servers` table, or nothing where the config carries no such table. */
const mcpServersToml = (servers: CodexConfigValue | undefined) =>
  isTable(servers)
    ? Object.entries(servers)
        .flatMap(([name, server]) =>
          isTable(server) ? [serverToml(name, server)] : []
        )
        .join("\n")
    : "";

/**
 * The whole file, as a string. Pure, and the two settings are unconditional:
 * an install with no Executor gets a file that carries only them, because they
 * are what the tree needs and Executor is what the run happens to have.
 *
 * The bare keys are rendered before any table header, which TOML requires —
 * anything after `[mcp_servers.executor]` belongs to that table.
 */
export const codexConfigToml = (executor: ExecutorMcp | null) => {
  const config = codexExecutorConfig(executor);
  const roots = [
    `project_root_markers = [${JSON.stringify(ATM_ROOT_MARKER)}]`,
    `project_doc_max_bytes = ${CODEX_PROJECT_DOC_MAX_BYTES}`,
    "",
  ].join("\n");
  return config === null
    ? roots
    : `${roots}\n${mcpServersToml(config.config.mcp_servers)}`;
};

/**
 * Writes the run's Codex config into its `CODEX_HOME`.
 *
 * Called for a Codex turn and no other: the file belongs to that CLI, and a
 * `config.toml` appearing in Claude's config directory is a file its vendor
 * does not read and a reader has to explain.
 */
export const writeCodexConfig = Effect.fn("Codex.writeConfig")(
  function* (input: {
    /** The mounted system-owned `CODEX_HOME`, shared by every run on the host. */
    readonly agentHomeDir: string;
    /** Executor, or null where the install configured none. */
    readonly executor: ExecutorMcp | null;
  }) {
    const fs = yield* FileSystem;
    yield* fs.makeDirectory(input.agentHomeDir, { recursive: true });
    yield* fs.writeFileString(
      codexConfigPath(input.agentHomeDir),
      codexConfigToml(input.executor)
    );
  }
);
