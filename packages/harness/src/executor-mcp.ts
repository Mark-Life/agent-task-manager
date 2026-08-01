/**
 * Executor as an MCP server, in the shape each provider expects.
 *
 * Executor holds the connections to everything outside this system — Notion,
 * Jira, Google, PostHog, whatever a task turns out to need — behind a small set
 * of meta-tools over one streamable-HTTP endpoint. Wiring it here rather than
 * per provider is what keeps "which tools does a run have" a property of the
 * system instead of a property of which harness happened to pick up the task.
 *
 * Both settings are optional and absence is not an error: an unconfigured
 * install runs with no Executor tools, which is a smaller agent and not a
 * broken one. That is why every builder below returns null rather than failing,
 * and why nothing in this module reads config at import time.
 *
 * The credential is handled differently per provider for one concrete reason.
 * The Claude SDK passes its MCP map over a pipe, so a header carrying the key
 * is fine. The Codex SDK flattens its `config` object into `--config key=value`
 * arguments, and argv is world-readable on the host — so Codex is handed an
 * environment variable to read the token from rather than the token, and the
 * token itself rides the process environment where only its own user sees it.
 */

import type { Options } from "@anthropic-ai/claude-agent-sdk";
import type { CodexOptions } from "@openai/codex-sdk";
import { Config, Effect, Option, Redacted } from "effect";
import { trimmedOrNull } from "./env";

/** The MCP server name, and therefore the middle segment of every tool name. */
export const EXECUTOR_SERVER_NAME = "executor";

/**
 * What Executor's tools are called once a provider namespaces them. A prefix
 * rather than a list: Executor adds tools without asking us, and an allow-list
 * written as an enumeration silently stops covering the new ones.
 */
export const EXECUTOR_TOOL_PREFIX = `mcp__${EXECUTOR_SERVER_NAME}__`;

/** The org-scoped endpoint, e.g. `https://executor.sh/org_<id>/mcp`. */
export const EXECUTOR_URL_ENV_VAR = "EXECUTOR_MCP_URL";

/** The API key minted in the Executor dashboard. Also the variable Codex is pointed at. */
export const EXECUTOR_KEY_ENV_VAR = "EXECUTOR_MCP_KEY";

/** Executor, resolved. Present only when both halves were configured. */
export interface ExecutorMcp {
  /** Redacted so a config object logged whole does not print the key. */
  readonly key: Redacted.Redacted;
  readonly url: string;
}

/** Either half of the Executor configuration, as it arrives from anywhere. */
export interface ExecutorMcpInput {
  readonly key: string | null | undefined;
  readonly url: string | null | undefined;
}

/**
 * Executor from a url and a key, or null when either is missing. Pure, and the
 * single place the "both or neither" rule lives — a url with no key is an
 * endpoint that will 401 on every tool call, which is worse than no tools.
 */
export const makeExecutorMcp = (
  input: ExecutorMcpInput
): ExecutorMcp | null => {
  const url = trimmedOrNull(input.url);
  const key = trimmedOrNull(input.key);
  return url === null || key === null ? null : { key: Redacted.make(key), url };
};

/**
 * Executor as the environment configured it. Read where a provider layer is
 * built, not at import time, so a test can override it with a `ConfigProvider`
 * and a script that wants no Executor simply does not set the variables.
 */
export const readExecutorMcp = Effect.gen(function* () {
  const url = yield* Config.option(Config.string(EXECUTOR_URL_ENV_VAR));
  const key = yield* Config.option(Config.redacted(EXECUTOR_KEY_ENV_VAR));
  return makeExecutorMcp({
    key: Option.getOrNull(Option.map(key, Redacted.value)),
    url: Option.getOrNull(url),
  });
});

/**
 * The `options.mcpServers` map for the Claude Agent SDK, or null when Executor
 * is not configured — the caller spreads it in conditionally rather than
 * setting the key to nothing.
 */
export const claudeExecutorMcpServers = (
  executor: ExecutorMcp | null
): NonNullable<Options["mcpServers"]> | null =>
  executor === null
    ? null
    : {
        [EXECUTOR_SERVER_NAME]: {
          headers: { Authorization: `Bearer ${Redacted.value(executor.key)}` },
          type: "http",
          url: executor.url,
        },
      };

/** The `config` and `env` fragments a Codex invocation needs for Executor. */
export interface CodexExecutorConfig {
  /** Merged into `CodexOptions.config`; flattened by the SDK into `--config` arguments. */
  readonly config: NonNullable<CodexOptions["config"]>;
  /** Merged into `CodexOptions.env`; carries the token the config only names. */
  readonly env: Readonly<Record<string, string>>;
}

/**
 * Executor in Codex's TOML shape, or null when it is not configured.
 *
 * `bearer_token_env_var` names the variable rather than carrying the token,
 * which is the whole point: the config object becomes command-line arguments,
 * and a key in argv is a key in `ps`. The two halves are returned together so a
 * caller cannot merge the config and forget the environment.
 *
 * Tool approval is left to the invocation's own approval policy. A headless
 * Codex run already sets one, and naming a per-server default here would pin
 * this package to an enum that belongs to the CLI's config schema.
 */
export const codexExecutorConfig = (
  executor: ExecutorMcp | null
): CodexExecutorConfig | null =>
  executor === null
    ? null
    : {
        config: {
          mcp_servers: {
            [EXECUTOR_SERVER_NAME]: {
              bearer_token_env_var: EXECUTOR_KEY_ENV_VAR,
              url: executor.url,
            },
          },
        },
        env: { [EXECUTOR_KEY_ENV_VAR]: Redacted.value(executor.key) },
      };
