#!/usr/bin/env bun

/**
 * The process the provider launches: read the environment, build one client,
 * serve MCP on stdin and stdout.
 *
 * This file is what gets bundled onto the run mount, so it keeps its own
 * dependencies to the client and the tool table. It does not build a telemetry
 * layer and does not log: its rows belong to the turn that started it, the
 * container's `atm.turn` event already covers the turn, and a logger writing to
 * stdout would corrupt the protocol carried on the same file descriptor.
 *
 * It stays alive because the stdio transport is listening on stdin. When the
 * provider closes that pipe the loop drains and the process ends — the same
 * lifetime as the turn, with nothing to shut down.
 */

import process from "node:process";
import { Effect } from "effect";
import { FetchHttpClient } from "effect/unstable/http";
import { makeGatewayClient } from "./client";
import { readGatewayConfig } from "./config";
import { makeManagerMcpServer, serveOverStdio } from "./server";

/** Read the configuration, connect the transport, and hand over to the pipe. */
export const runManagerMcpServer = Effect.gen(function* () {
  const config = yield* readGatewayConfig;
  const client = yield* makeGatewayClient(config);
  yield* serveOverStdio(makeManagerMcpServer(client));
}).pipe(Effect.provide(FetchHttpClient.layer));

if (import.meta.main) {
  Effect.runPromise(runManagerMcpServer).catch((cause: unknown) => {
    process.stderr.write(`manager-mcp: ${String(cause)}\n`);
    process.exit(1);
  });
}
