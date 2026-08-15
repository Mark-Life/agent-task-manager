import { describe, expect, it } from "bun:test";
import { Redacted } from "effect";
// The writer lives in `@workspace/agent-tools`, which depends on this package —
// so it is reached by path rather than by name, because a dependency the other
// way would close a cycle. Reaching it at all is the point: nothing else binds
// the shape that process writes to the shape this one reads, and a hand-copied
// literal here would agree with itself while the two drifted apart.
import {
  AGENT_SERVER_NAME,
  type AgentMcpStdio,
  agentMcpServersFile,
} from "../../agent-tools/src/provider-config";
import {
  type ClaudeMcpServers,
  type McpServer,
  type McpServers,
  parseMcpServersFile,
} from "./mcp-servers";

/**
 * The hand-off this module exists for, stated as a type. A decoded map that no
 * longer fits the SDK's own is a cast waiting to be put back, and it fails here
 * rather than at the call in `./claude`.
 */
const asSdkMap = (servers: McpServers): ClaudeMcpServers => servers;

/** The board server as a run actually mounts it, credential and all. */
const boardServer = (
  credential: AgentMcpStdio["credential"]
): AgentMcpStdio => ({
  bundlePath: "/run/atm/agent-mcp.js",
  credential,
  gatewayUrl: "http://host.docker.internal:3100",
  role: "worker",
});

/** The file that server is written as, as one string. */
const written = (server: AgentMcpStdio) =>
  JSON.stringify(agentMcpServersFile(server));

/** The parse, with "not a file of servers" as a failed test rather than a branch. */
const readOrFail = (text: string) => {
  const read = parseMcpServersFile(text);
  if (read === null) {
    throw new Error(`expected a file of servers: ${text}`);
  }
  return read;
};

/** Both credential shapes the writer can put on the mount. */
const CREDENTIALS: readonly (readonly [string, AgentMcpStdio["credential"]])[] =
  [
    ["a credential file", { kind: "file", path: "/run/atm/token" }],
    ["a fixed token", { kind: "value", token: Redacted.make("t0ken") }],
  ];

describe("parseMcpServersFile", () => {
  it.each(CREDENTIALS)(
    "reads back what the writer wrote, with %s",
    (_label, credential) => {
      const server = boardServer(credential);
      const read = readOrFail(written(server));

      expect(read.dropped).toEqual([]);
      expect(agentMcpServersFile(server).mcpServers).toEqual(read.servers);
    }
  );

  it("hands the board server over as the SDK's own map", () => {
    const read = readOrFail(
      written(boardServer({ kind: "file", path: "/run/atm/token" }))
    );

    expect(Object.keys(asSdkMap(read.servers))).toEqual([AGENT_SERVER_NAME]);
  });

  it.each([
    ["not json", "not json at all"],
    ["nothing", ""],
    ["a truncated object", '{"mcpServers": {"atm": {"command": "bun"'],
    ["not an object", '"a string"'],
    ["an mcpServers that is not an object", '{"mcpServers": 7}'],
  ])("answers null for a file holding %s", (_label, text) => {
    expect(parseMcpServersFile(text)).toBeNull();
  });

  it("reads a file with no mcpServers key as a turn with no extra servers", () => {
    expect(parseMcpServersFile('{"other": 1}')).toEqual({
      dropped: [],
      servers: {},
    });
  });

  it("decodes a bare stdio server", () => {
    const read = readOrFail('{"mcpServers":{"tool":{"command":"bun"}}}');

    expect(read.dropped).toEqual([]);
    expect(read.servers).toEqual({ tool: { command: "bun" } });
  });

  it("decodes a stdio server carrying every field it may", () => {
    const entry = {
      args: ["/run/atm/agent-mcp.js"],
      command: "bun",
      env: { ATM_GATEWAY_URL: "http://gateway" },
      type: "stdio",
    } satisfies McpServer;
    const read = readOrFail(JSON.stringify({ mcpServers: { a: entry } }));

    expect(read.servers).toEqual({ a: entry });
  });

  it("decodes an http server", () => {
    const entry = {
      headers: { Authorization: "Bearer k" },
      type: "http",
      url: "https://executor.sh/org_1/mcp",
    } satisfies McpServer;
    const read = readOrFail(JSON.stringify({ mcpServers: { e: entry } }));

    expect(read.servers).toEqual({ e: entry });
  });

  it("drops a per-server field this build does not name", () => {
    const read = readOrFail(
      '{"mcpServers":{"a":{"command":"bun","timeout":5000}}}'
    );

    expect(read.dropped).toEqual([]);
    expect(read.servers).toEqual({ a: { command: "bun" } });
  });

  it("drops a url with no transport rather than guessing one", () => {
    const read = readOrFail(
      '{"mcpServers":{"a":{"url":"https://example.com/mcp"}}}'
    );

    expect(read.dropped).toEqual(["a"]);
    expect(read.servers).toEqual({});
  });

  it("keeps the servers it can start and names the ones it cannot", () => {
    const read = readOrFail(
      '{"mcpServers":{"good":{"command":"bun"},"bad":{"command":7}}}'
    );

    expect(read.dropped).toEqual(["bad"]);
    expect(read.servers).toEqual({ good: { command: "bun" } });
  });
});
