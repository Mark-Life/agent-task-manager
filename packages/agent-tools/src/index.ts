/**
 * The manager's tools: the gateway contract, as an MCP server a provider can
 * launch.
 *
 * The manager agent has no database handle, no container and no privileged
 * path. Everything it does to the board goes through the same HTTP contract a
 * dashboard uses, holding a short-lived `task-write` token — so what a chat can
 * change is exactly the tools in `./tools` and nothing else. That token still
 * cannot delete a project; deleting a *task* it can do, because clearing a card
 * off the board on somebody's say-so is ordinary work and the alternative was a
 * credential that could erase a project too.
 *
 * What this package deliberately does not do: it does not mint the token (the
 * bot does, per turn, and hands it over on a mount), it does not decide which
 * directories a turn gets, and it does not emit telemetry — the turn that
 * launched the server owns the row.
 *
 * The MCP server itself is behind the `./server` subpath and the process behind
 * `./main`, so a host-side caller wiring the provider configuration never pulls
 * the MCP SDK in with it.
 */

export {
  AGENT_MCP_BUNDLE_FILE,
  AGENT_MCP_SEGMENT,
  AGENT_TOKEN_FILE,
  agentMcpBundlePathOf,
  agentMcpPendingPathOf,
  agentTokenPathOf,
  CONTAINER_AGENT_TOKEN_PATH,
} from "./bundle";
export type { GatewayClient } from "./client";
export { makeGatewayClient } from "./client";
export type { GatewayConfig, GatewayCredential } from "./config";
export {
  currentGatewayToken,
  GATEWAY_TOKEN_ENV_VAR,
  GATEWAY_TOKEN_FILE_ENV_VAR,
  GATEWAY_URL_ENV_VAR,
  GatewayTokenUnreadable,
  readGatewayConfig,
} from "./config";
export type { AgentMcpStdio, CodexManagerConfig } from "./provider-config";
export {
  AGENT_MCP_COMMAND,
  AGENT_SERVER_NAME,
  AGENT_TOOL_PREFIX,
  agentMcpServersFile,
  claudeManagerMcpServers,
  codexManagerConfig,
} from "./provider-config";
export type { AgentTool } from "./tool";
export { describeFailure, ToolFailed, toolInputJsonSchema } from "./tool";
export { AGENT_TOOLS, agentToolByName } from "./tools";
