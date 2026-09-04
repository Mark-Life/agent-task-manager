/**
 * The board tools as a Pi extension, because Pi ships no MCP client.
 *
 * Pi says so itself: "It intentionally does not include built-in MCP,
 * sub-agents, permission popups, plan mode, to-dos, or background bash." The
 * manager agent's only route to the board is this tool table, so on Pi the
 * table has to arrive some other way — and the way Pi offers is an extension
 * that calls `pi.registerTool` once per tool. That is the whole of the missing
 * layer. It is not a second tool table, a second contract, or a second set of
 * permissions: it is `./call` and `./tools`, the same ones `./server` hands to
 * an MCP client, wearing a different hat.
 *
 * What is genuinely different is three things.
 *
 * **The schema goes over as JSON Schema.** Pi's documented `parameters` is a
 * typebox schema, but a typebox schema *is* a JSON Schema object at runtime and
 * Pi passes it to the provider untouched — verified against a live turn, where
 * the `tools[].function.parameters` the model was shown was byte-for-byte the
 * document `toolInputJsonSchema` produced. So the contract's own generated
 * schema goes across with nothing in between, exactly as it does over MCP.
 *
 * **A failure has to be thrown.** Pi's rule is that returning a value never
 * sets the error flag, whatever the value holds; throwing is what marks the
 * call failed and puts the message in front of the model. So the one readable
 * line `./call` produces is thrown here rather than returned, which is the same
 * answer delivered the way this protocol reads it.
 *
 * **There is no tool search, so there is no `alwaysLoad`.** Every tool
 * registered here is in every prompt. That is a real cost — nineteen schemas —
 * and it is also why a Pi manager should be started with `--no-builtin-tools`:
 * a chat agent has no use for `edit` and `write`, and the room they take is
 * room the board tools need.
 *
 * **This file runs inside Pi's process, not ours.** It is bundled to one file
 * for node and loaded with `pi -e <path>`; it has no telemetry, emits no rows,
 * and its lifetime is the turn that launched it. It writes nothing to stdout —
 * Pi's own JSON event stream is on that descriptor, and a stray line there is a
 * parse error in the harness.
 */

import type { RunRole } from "@workspace/domain";
import { Effect } from "effect";
import { FetchHttpClient } from "effect/unstable/http";
import { callAgentTool } from "./call";
import { type GatewayClient, makeGatewayClient } from "./client";
import { readGatewayConfig } from "./config";
import { agentToolsFor } from "./tools";

/**
 * The half of Pi's `ExtensionAPI` this file uses, declared structurally rather
 * than imported.
 *
 * Importing `@earendil-works/pi-coding-agent` for two type names would put the
 * whole coding agent — its TUI, its provider catalog, its own model clients —
 * into this package's dependency graph and into the bundle a container mounts,
 * to describe a function signature. The shape below is small, stable, and the
 * bundle is verified against the real CLI by `bun run agent-tools:check`, which
 * is a stronger check than a type would be: a structural mismatch shows up as a
 * turn whose tools do not appear, and that is what the check looks for.
 */
interface PiToolResult {
  readonly content: readonly { readonly text: string; readonly type: "text" }[];
  readonly details: Readonly<Record<string, unknown>>;
}

/** The one method this extension calls, and the shape it calls it with. */
interface PiExtensionApi {
  readonly registerTool: (tool: {
    readonly description: string;
    readonly execute: (
      toolCallId: string,
      params: unknown
    ) => Promise<PiToolResult>;
    readonly label: string;
    readonly name: string;
    readonly parameters: unknown;
  }) => void;
}

/** A tool's answer in the shape Pi reads. */
const piResult = (text: string): PiToolResult => ({
  content: [{ text, type: "text" }],
  details: {},
});

/**
 * Registers one Pi tool per board tool, against a client and a role that have
 * already been resolved.
 *
 * Separated from the factory below so the registration can be driven with no
 * environment and no network: what a role is listed, what schema each tool
 * carries and how a failure is raised are answerable without a gateway, and the
 * environment reading is `./config`'s and is tested there.
 */
export const registerBoardTools = (
  pi: PiExtensionApi,
  options: { readonly client: GatewayClient; readonly role: RunRole }
) => {
  const { client, role } = options;
  for (const tool of agentToolsFor(role)) {
    pi.registerTool({
      description: tool.description,
      execute: async (_toolCallId, params) => {
        const answer = await Effect.runPromise(
          callAgentTool({ args: params, client, name: tool.name, role })
        );
        if (answer.isError) {
          // Pi's own rule: a returned value is never an error, however it is
          // shaped. Throwing is what puts the line in front of the model.
          throw new Error(answer.text);
        }
        return piResult(answer.text);
      },
      label: tool.name,
      name: tool.name,
      parameters: tool.inputJsonSchema,
    });
  }
};

/**
 * What `pi -e <path>` loads: Pi calls this with its API, once, at startup.
 *
 * Async, which Pi awaits before the session starts, so every tool is registered
 * before the first prompt is built — there is no window in which the model is
 * shown a shorter table than it will have.
 *
 * A missing configuration fails the factory, and that is deliberate: Pi reports
 * the extension that would not load, and a manager silently holding no board
 * tools is a chat that cannot do anything and cannot say why. The MCP server
 * takes the same position for the same reason.
 */
export default async function boardToolsExtension(pi: PiExtensionApi) {
  const config = await Effect.runPromise(readGatewayConfig);
  const client = await Effect.runPromise(
    Effect.provide(makeGatewayClient(config), FetchHttpClient.layer)
  );
  registerBoardTools(pi, { client, role: config.role });
}
