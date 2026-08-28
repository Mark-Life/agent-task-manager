/**
 * The board tools as an MCP server the provider launches over stdio.
 *
 * The gateway speaks HttpApi, not MCP, and teaching it MCP would be a second
 * protocol surface with its own authentication and its own way to get a scope
 * wrong. So the translation lives here, in one file bundled onto the run mount:
 * the provider starts it, it holds one typed client, and every tool call is one
 * HTTP request with the turn's token on it.
 *
 * **Nothing may be written to stdout.** Stdout *is* the protocol — a stray log
 * line is a parse error at the other end and a server that appears to have
 * crashed. Diagnostics go to stderr, which the container's log already carries.
 *
 * **A failure is a result, not a throw.** Every ending comes back as a tool
 * result marked as an error with one readable line in it. That rule and the
 * lookup behind it live in `./call`, which is protocol-neutral because the Pi
 * extension beside this file has to answer identically; what is left here is
 * MCP's own shape for the same answer.
 */

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import type { RunRole } from "@workspace/domain";
import { Effect } from "effect";
import { callAgentTool, type ToolAnswer } from "./call";
import type { GatewayClient } from "./client";
import { AGENT_SERVER_NAME } from "./provider-config";
import type { AgentTool } from "./tool";
import { agentToolsFor } from "./tools";

/**
 * What this server calls itself to an MCP client. Its own number, not the
 * repository's: a client caches a tool listing against it, and the tools change
 * when the contract does rather than when the monorepo releases.
 */
export const AGENT_MCP_VERSION = "1.0.0";

/**
 * The key a Claude client reads off a listed tool to decide the tool is not
 * deferred behind tool search. Claude's own SDK writes it into `_meta` for the
 * servers it hosts in-process; the client honours it from any server's
 * `tools/list`, which is how a tool over stdio opts out one name at a time
 * rather than the whole server at once.
 */
export const ALWAYS_LOAD_META = "anthropic/alwaysLoad";

/**
 * One tool as an MCP client is told about it.
 *
 * `_meta` is omitted rather than sent empty: a client that does not know the key
 * should see the listing it would have seen before it existed.
 */
export const listedTool = (tool: AgentTool) => ({
  description: tool.description,
  inputSchema: tool.inputJsonSchema,
  name: tool.name,
  ...(tool.alwaysLoad ? { _meta: { [ALWAYS_LOAD_META]: true } } : {}),
});

/** A tool answer in the shape an MCP client reads. */
const toolResult = (answer: ToolAnswer) => ({
  content: [{ text: answer.text, type: "text" as const }],
  isError: answer.isError,
});

/**
 * The server, wired to one client and one role. Pure construction — the
 * transport is connected by the entrypoint, so a test can drive the handlers
 * directly.
 *
 * The role reaches this process in its environment and nowhere else
 * (`AGENT_ROLE_ENV_VAR` in `./config`), because nothing else here knows it: the
 * credential says which task a run may write, not which job the turn is doing.
 */
export const makeManagerMcpServer = (options: {
  readonly client: GatewayClient;
  readonly role: RunRole;
}) => {
  const server = new Server(
    { name: AGENT_SERVER_NAME, version: AGENT_MCP_VERSION },
    { capabilities: { tools: {} } }
  );
  const listed = agentToolsFor(options.role).map(listedTool);
  server.setRequestHandler(ListToolsRequestSchema, () =>
    Promise.resolve({ tools: listed })
  );
  server.setRequestHandler(CallToolRequestSchema, (request) =>
    Effect.runPromise(
      Effect.map(
        callAgentTool({
          args: request.params.arguments,
          client: options.client,
          name: request.params.name,
          role: options.role,
        }),
        toolResult
      )
    )
  );
  return server;
};

/** Serve on stdin/stdout until the provider closes the pipe. */
export const serveOverStdio = (
  server: ReturnType<typeof makeManagerMcpServer>
) => Effect.promise(() => server.connect(new StdioServerTransport()));
