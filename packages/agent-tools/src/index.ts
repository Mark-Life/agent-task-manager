/**
 * The manager's tools: the gateway contract, as an MCP server a provider can
 * launch.
 *
 * The manager agent has no database handle, no container and no privileged
 * path. Everything it does to the board goes through the same HTTP contract a
 * dashboard uses, holding a short-lived `task-write` token that cannot reach
 * the deletes — so what a chat can change is exactly the fourteen tools in
 * `./tools` and nothing else.
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
  agentMcpBundlePathOf,
  agentMcpRunCopyPathOf,
  CONTAINER_AGENT_MCP_PATH,
} from "./bundle";
export type { GatewayClient } from "./client";
export { makeGatewayClient } from "./client";
export type { GatewayConfig } from "./config";
export {
  GATEWAY_TOKEN_ENV_VAR,
  GATEWAY_URL_ENV_VAR,
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
