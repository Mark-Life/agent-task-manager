/**
 * What Pi is told about the board.
 *
 * The half worth testing here is registration: that every tool the role is
 * listed reaches Pi under its own name with the contract's own schema, and that
 * a failure is raised the way Pi requires rather than returned. The calls
 * themselves are `./call`'s, which the MCP path shares; the environment reading
 * is `./config`'s; and a whole turn through the bundled extension is what a
 * `pi -e` session against a gateway proves.
 */

import { describe, expect, it } from "bun:test";
import type { RunRole } from "@workspace/domain";
import { Effect, Redacted } from "effect";
import { FetchHttpClient } from "effect/unstable/http";
import { type GatewayClient, makeGatewayClient } from "./client";
import { registerBoardTools } from "./pi-extension";
import { agentToolsFor } from "./tools";

/**
 * A real client pointed at a host that does not exist. Every assertion below is
 * answered before a request is made — a listing, a schema, or an argument the
 * contract's own decoder refuses — so nothing here reaches the network.
 */
const client: GatewayClient = await Effect.runPromise(
  Effect.provide(
    makeGatewayClient({
      baseUrl: "http://gateway.invalid",
      credential: { kind: "value", token: Redacted.make("test-token") },
      role: "manager",
    }),
    FetchHttpClient.layer
  )
);

/** The failure a tool raises names the tool, so a reader knows which one refused. */
const NAMES_THE_TOOL = /tasks_get/;

/** One registered tool, as this file needs to read it back. */
interface Registered {
  readonly description: string;
  readonly execute: (id: string, params: unknown) => Promise<unknown>;
  readonly label: string;
  readonly name: string;
  readonly parameters: unknown;
}

/** Registers against a recorder, and hands back what Pi would have been told. */
const register = (role: RunRole): readonly Registered[] => {
  const registered: Registered[] = [];
  registerBoardTools(
    {
      registerTool: (tool) => {
        registered.push(tool as Registered);
      },
    },
    { client, role }
  );
  return registered;
};

describe("registerBoardTools", () => {
  it("registers exactly the tools the manager's listing holds", () => {
    expect(register("manager").map((tool) => tool.name)).toEqual(
      agentToolsFor("manager").map((tool) => tool.name)
    );
  });

  it("registers the worker's narrower listing when the turn is a worker's", () => {
    const names = register("worker").map((tool) => tool.name);
    expect(names).toEqual(agentToolsFor("worker").map((tool) => tool.name));
    // The three a worker's binding refuses on every call it could make.
    expect(names).not.toContain("tasks_create");
    expect(names).not.toContain("tasks_delete");
    expect(names).not.toContain("projects_create");
  });

  it("hands over the contract's own generated schema, not a restatement", () => {
    const registered = register("manager");
    for (const tool of agentToolsFor("manager")) {
      const found = registered.find((each) => each.name === tool.name);
      expect(found?.parameters).toBe(tool.inputJsonSchema);
      expect(found?.description).toBe(tool.description);
    }
  });

  it("throws on a failure, because a returned value never marks one in Pi", async () => {
    const tasksGet = register("manager").find(
      (tool) => tool.name === "tasks_get"
    );
    expect(tasksGet).toBeDefined();
    // A task id that is not one: the contract's decoder refuses it before any
    // request is made, so this needs no gateway.
    await expect(
      tasksGet?.execute("call-1", { taskId: "not-a-uuid" })
    ).rejects.toThrow(NAMES_THE_TOOL);
  });
});
