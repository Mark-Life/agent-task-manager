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
 * **A failure is a result, not a throw.** Every ending — a refused command, a
 * 404, a connection refused, a defect — comes back as a tool result marked as an
 * error with one readable line in it. A model shown a stack either narrates it
 * to a person or invents a cause; a model shown "NotFound: no task with that id"
 * can say so and carry on.
 */

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { Cause, Effect, Exit } from "effect";
import type { GatewayClient } from "./client";
import { AGENT_SERVER_NAME } from "./provider-config";
import type { ToolFailed } from "./tool";
import { AGENT_TOOLS, agentToolByName } from "./tools";

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
export const listedTool = (tool: (typeof AGENT_TOOLS)[number]) => ({
  description: tool.description,
  inputSchema: tool.inputJsonSchema,
  name: tool.name,
  ...(tool.alwaysLoad ? { _meta: { [ALWAYS_LOAD_META]: true } } : {}),
});

/** A tool result carrying text, and whether the text is what went wrong. */
const toolResult = (options: {
  readonly isError: boolean;
  readonly text: string;
}) => ({
  content: [{ text: options.text, type: "text" as const }],
  isError: options.isError,
});

/**
 * One tool call, always succeeding.
 *
 * A tool the client does not know about is answered rather than thrown: MCP
 * clients cache tool listings, and a model calling a name that has moved
 * deserves to be told which names exist.
 */
export const callAgentTool = (options: {
  readonly args: unknown;
  readonly client: GatewayClient;
  readonly name: string;
}) => {
  const tool = agentToolByName(options.name);
  if (tool === undefined) {
    return Effect.succeed(
      toolResult({
        isError: true,
        text: `no such tool: ${options.name}. Available: ${AGENT_TOOLS.map((each) => each.name).join(", ")}`,
      })
    );
  }
  return Effect.exit(tool.call(options.client, options.args)).pipe(
    Effect.map((exit) =>
      Exit.isSuccess(exit)
        ? toolResult({ isError: false, text: exit.value })
        : toolResult({ isError: true, text: describeCause(exit.cause) })
    )
  );
};

/** A failed call as one line: the tool's own message when it has one, the cause otherwise. */
const describeCause = (cause: Cause.Cause<ToolFailed>) => {
  const failure = Cause.findErrorOption(cause);
  return failure._tag === "Some" ? failure.value.message : Cause.pretty(cause);
};

/**
 * The server, wired to one client. Pure construction — the transport is
 * connected by the entrypoint, so a test can drive the handlers directly.
 */
export const makeManagerMcpServer = (client: GatewayClient) => {
  const server = new Server(
    { name: AGENT_SERVER_NAME, version: AGENT_MCP_VERSION },
    { capabilities: { tools: {} } }
  );
  server.setRequestHandler(ListToolsRequestSchema, () =>
    Promise.resolve({ tools: AGENT_TOOLS.map(listedTool) })
  );
  server.setRequestHandler(CallToolRequestSchema, (request) =>
    Effect.runPromise(
      callAgentTool({
        args: request.params.arguments,
        client,
        name: request.params.name,
      })
    )
  );
  return server;
};

/** Serve on stdin/stdout until the provider closes the pipe. */
export const serveOverStdio = (
  server: ReturnType<typeof makeManagerMcpServer>
) => Effect.promise(() => server.connect(new StdioServerTransport()));
