/**
 * This server as an MCP entry in the shape each provider expects.
 *
 * The mirror of `packages/harness/src/executor-mcp.ts`, for a command rather
 * than a url: Executor is a hosted endpoint the container reaches over HTTP,
 * and this one is a file on the run mount the provider launches. The per-vendor
 * split is the same security decision. The Claude SDK hands its `mcpServers`
 * map to its CLI over a pipe, so the token may ride in the server's `env`; the
 * Codex SDK flattens its `config` object into `--config key=value` arguments,
 * and argv is readable by every process on the host, so Codex is given the
 * command and its arguments in the config and the token only in the process
 * environment the stdio child inherits.
 *
 * **Codex needs one change elsewhere before this fragment reaches it.**
 * `codexMcpToml` in `packages/harness/src/entrypoint.ts` renders only the
 * string-valued fields of each server, so the `args` array below is silently
 * dropped and the server would be launched with no script to run. Extending
 * that renderer is a separate decision; until it is made, the Claude half is
 * the one in use.
 *
 * Everything here is pure and absence is not an error: a turn configured with
 * no gateway gets no board tools, which is a smaller manager and not a broken
 * one — hence the nulls rather than failures.
 */

import type { Options } from "@anthropic-ai/claude-agent-sdk";
import type { CodexOptions } from "@openai/codex-sdk";
import { Redacted } from "effect";
import {
  GATEWAY_TOKEN_ENV_VAR,
  GATEWAY_TOKEN_FILE_ENV_VAR,
  GATEWAY_URL_ENV_VAR,
  type GatewayCredential,
} from "./config";

/** The MCP server name, and therefore the middle segment of every tool name. */
export const AGENT_SERVER_NAME = "atm";

/** What the board tools are called once a provider namespaces them. */
export const AGENT_TOOL_PREFIX = `mcp__${AGENT_SERVER_NAME}__`;

/** The runtime that runs the bundle. Resolved on `PATH` — every image here pins bun. */
export const AGENT_MCP_COMMAND = "bun";

/** What launching this server takes, once the bundle is on a mount the container can read. */
export interface AgentMcpStdio {
  /** The bundle's path **inside the container**, e.g. `/run/agent-mcp.js`. */
  readonly bundlePath: string;
  /**
   * Where the turn's credential comes from. A path is named **as the process
   * that reads it sees it**, which for a contained turn is the container's
   * spelling of the run mount and not the host's.
   */
  readonly credential: GatewayCredential;
  /** The gateway's base url as the container sees it. */
  readonly gatewayUrl: string;
}

/**
 * The two variables the server reads, filled in for one turn.
 *
 * A rolling credential puts a path here and no token, so nothing in the
 * provider's configuration — which is written to a file and handed across a
 * pipe — carries the secret itself. A fixed one still puts the value here,
 * because a process that was handed a token has nowhere else to keep it.
 */
const stdioEnv = (server: AgentMcpStdio) => ({
  ...(server.credential.kind === "file"
    ? { [GATEWAY_TOKEN_FILE_ENV_VAR]: server.credential.path }
    : { [GATEWAY_TOKEN_ENV_VAR]: Redacted.value(server.credential.token) }),
  [GATEWAY_URL_ENV_VAR]: server.gatewayUrl,
});

/**
 * The `options.mcpServers` map for the Claude Agent SDK, or null when no
 * gateway was configured — the caller spreads it in conditionally rather than
 * setting the key to nothing.
 */
export const claudeManagerMcpServers = (
  server: AgentMcpStdio | null
): NonNullable<Options["mcpServers"]> | null =>
  server === null
    ? null
    : {
        [AGENT_SERVER_NAME]: {
          args: [server.bundlePath],
          command: AGENT_MCP_COMMAND,
          env: stdioEnv(server),
          type: "stdio",
        },
      };

/** The `config` and `env` fragments a Codex invocation needs for the board tools. */
export interface CodexManagerConfig {
  /** Merged into `CodexOptions.config`; flattened by the SDK into `--config` arguments. */
  readonly config: NonNullable<CodexOptions["config"]>;
  /** Merged into `CodexOptions.env`; carries the credential the config never names. */
  readonly env: Readonly<Record<string, string>>;
}

/**
 * The board tools in Codex's TOML shape, or null when no gateway was
 * configured.
 *
 * The token is in the environment and not in the config, because the config
 * becomes command-line arguments and a token in argv is a token in `ps`. The
 * two halves are returned together so a caller cannot merge the config and
 * forget the environment — and because Codex's SDK stops inheriting
 * `process.env` the moment `env` is set, the caller merges rather than replaces.
 */
export const codexManagerConfig = (
  server: AgentMcpStdio | null
): CodexManagerConfig | null =>
  server === null
    ? null
    : {
        config: {
          mcp_servers: {
            [AGENT_SERVER_NAME]: {
              args: [server.bundlePath],
              command: AGENT_MCP_COMMAND,
            },
          },
        },
        env: stdioEnv(server),
      };

/**
 * The `mcpServers` object written to `<threadRunDir>/mcp-servers.json`, which is
 * how the credential reaches the container: on a mount the entrypoint reads and
 * the host deletes after the turn, never in the container's own environment
 * (`docker inspect` prints that) and never in its argv (`ps` prints that).
 */
export const agentMcpServersFile = (server: AgentMcpStdio) => ({
  mcpServers: claudeManagerMcpServers(server),
});
