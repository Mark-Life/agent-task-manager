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
import type { RunRole } from "@workspace/domain";
import { Cause, Effect, Exit } from "effect";
import type { GatewayClient } from "./client";
import { AGENT_SERVER_NAME } from "./provider-config";
import type { AgentTool, ToolFailed } from "./tool";
import { agentToolByName, agentToolsFor } from "./tools";

/**
 * What this server calls itself to an MCP client. Its own number, not the
 * repository's: a client caches a tool listing against it, and the tools change
 * when the contract does rather than when the monorepo releases.
 */
export const AGENT_MCP_VERSION = "1.0.0";

/** One tool as an MCP client is told about it. */
const listedTool = (tool: AgentTool) => ({
  description: tool.description,
  inputSchema: tool.inputJsonSchema,
  name: tool.name,
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
 *
 * **The role narrows what is listed and never what is called.** A name in the
 * table is looked up and run whatever role asked for it, so a worker that calls
 * a tool its listing left out gets the gateway's own refusal — `Forbidden:
 * unscoped_route`, which says what the rule is — rather than this file's "no
 * such tool", which would say the board had changed. The names offered back
 * after a genuine miss are that role's, because those are the ones worth
 * trying.
 */
export const callAgentTool = (options: {
  readonly args: unknown;
  readonly client: GatewayClient;
  readonly name: string;
  readonly role: RunRole;
}) => {
  const tool = agentToolByName(options.name);
  if (tool === undefined) {
    const offered = agentToolsFor(options.role).map((each) => each.name);
    return Effect.succeed(
      toolResult({
        isError: true,
        text: `no such tool: ${options.name}. Available: ${offered.join(", ")}`,
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
      callAgentTool({
        args: request.params.arguments,
        client: options.client,
        name: request.params.name,
        role: options.role,
      })
    )
  );
  return server;
};

/** Serve on stdin/stdout until the provider closes the pipe. */
export const serveOverStdio = (
  server: ReturnType<typeof makeManagerMcpServer>
) => Effect.promise(() => server.connect(new StdioServerTransport()));
