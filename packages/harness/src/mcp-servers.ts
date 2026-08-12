/**
 * The `mcpServers` file a host leaves on the run mount, read into the shape the
 * Claude SDK takes.
 *
 * Both ends of this already have a precise type — `claudeManagerMcpServers` in
 * `@workspace/agent-tools` builds the map, `Options.mcpServers` consumes it —
 * and what sits between them is a JSON file written by one process and read by
 * another inside a container. Parsing it here is what keeps those ends from
 * being joined by a cast: what the host actually left on the mount reaches the
 * SDK only if it is one of the shapes this build knows how to launch.
 *
 * **Tolerance is per entry, and that is the design.** A turn whose file this
 * build cannot read gets fewer tools, never a failed turn — the same rule the
 * rest of the harness applies to an absent Executor. Applied to a file holding
 * several servers, that rule has to be applied per server: refusing the whole
 * file over one entry would take the board tools away with it, which is the
 * silent toolless agent this parsing exists to prevent rather than a stricter
 * version of it.
 */

import type { Options } from "@anthropic-ai/claude-agent-sdk";
import { Option, Schema } from "effect";

/**
 * A server the provider launches as a child process.
 *
 * `args` is mutable, and that is load-bearing: the SDK declares
 * `McpStdioServerConfig.args` as `string[]`, and a `readonly string[]` is not
 * assignable to it — so the default readonly array would put back the cast at
 * the hand-off that this module exists to remove. `env` needs no such treatment
 * because a readonly index signature is assignable to a mutable one.
 */
const StdioServer = Schema.Struct({
  args: Schema.optionalKey(Schema.mutable(Schema.Array(Schema.String))),
  command: Schema.String,
  env: Schema.optionalKey(Schema.Record(Schema.String, Schema.String)),
  type: Schema.optionalKey(Schema.Literal("stdio")),
});

/**
 * A server the provider connects to over HTTP or SSE.
 *
 * `type` is required, so an entry that carries a `url` and nothing else is
 * dropped: the SDK's `McpHttpServerConfig` and `McpSSEServerConfig` both
 * declare it as a required literal, so there is nothing to hand over — and
 * picking one would open a connection over a transport the operator never
 * named.
 */
const RemoteServer = Schema.Struct({
  headers: Schema.optionalKey(Schema.Record(Schema.String, Schema.String)),
  type: Schema.Literals(["http", "sse"]),
  url: Schema.String,
});

/**
 * One server entry.
 *
 * Per-server fields this union does not name — `timeout`, `tools` — are dropped
 * rather than refused, which is Effect's default for excess properties and the
 * smaller loss of the two: a vendor that adds a knob between releases costs a
 * turn that knob, where refusing would cost the turn the server.
 */
export const McpServer = Schema.Union([StdioServer, RemoteServer]);
export type McpServer = typeof McpServer.Type;

/**
 * The map as it comes off the file. The *names* are open — they are the
 * operator's to choose — and the shapes are not, which is the whole of what
 * reading this file through a schema buys.
 */
export interface McpServers {
  readonly [name: string]: McpServer;
}

/**
 * The map as the pipeline carries it, named for its vendor because it is the
 * vendor's own: it admits the SDK's in-process `{ type: "sdk", instance }`
 * server, which no file can describe, and it sits on `RunOptions` in
 * `./provider`, the interface every provider implements. A neutral name there
 * would read as something the Codex provider also takes, and it does not.
 */
export type ClaudeMcpServers = NonNullable<Options["mcpServers"]>;

/**
 * The outer shape alone. The JSON parse lives inside the decoder so no caller
 * has to guard a `throw`, and the entries stay `unknown` at this level so one
 * the union rejects can be dropped by name instead of taking the file with it.
 */
const McpServersFile = Schema.fromJsonString(
  Schema.Struct({
    mcpServers: Schema.optionalKey(
      Schema.Record(Schema.String, Schema.Unknown)
    ),
  })
);

/** Decoders built once — they compile an AST on every call otherwise. */
const decodeFile = Schema.decodeUnknownOption(McpServersFile);
const decodeServer = Schema.decodeUnknownOption(McpServer);

/** What one file turned out to hold. */
export interface McpServersRead {
  /**
   * The names this build has no way to launch. Handed back rather than logged
   * here, because the caller is the one holding a logger and the file's path.
   */
  readonly dropped: readonly string[];
  /** The servers this build can start. */
  readonly servers: McpServers;
}

/**
 * One file's servers, or null where it is not a file of servers at all: not
 * JSON, truncated, not an object, or an `mcpServers` that is not one.
 *
 * A file with no `mcpServers` key reads as an empty map rather than as null. A
 * turn with no extra servers is the ordinary case and says nothing about the
 * file, so it is not worth a warning at the caller.
 */
export const parseMcpServersFile = (text: string): McpServersRead | null => {
  const file = decodeFile(text);
  if (Option.isNone(file)) {
    return null;
  }
  const dropped: string[] = [];
  const servers: Record<string, McpServer> = {};
  for (const [name, entry] of Object.entries(file.value.mcpServers ?? {})) {
    const server = decodeServer(entry);
    if (Option.isNone(server)) {
      dropped.push(name);
      continue;
    }
    servers[name] = server.value;
  }
  return { dropped, servers };
};
