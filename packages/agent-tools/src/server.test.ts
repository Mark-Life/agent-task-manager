/**
 * What a client is told when it lists the tools.
 *
 * The listing is the whole contract for a tool a model has not called yet, and
 * one field of it decides whether the model can see the tool at all: a Claude
 * client defers every MCP tool behind tool search unless the listing marks it
 * otherwise. The stop hook will not let a turn end before a message is posted,
 * so `messages_post` being marked is the difference between a run that posts
 * and a run that first searches for the tool it cannot finish without.
 *
 * The calls themselves are covered by the check script against a real gateway.
 */

import { describe, expect, it } from "bun:test";
import { ALWAYS_LOAD_META, listedTool } from "./server";
import { AGENT_TOOLS, agentToolByName } from "./tools";

/** The listing as one object per name, which is how a client reads it. */
const listing = () =>
  new Map(AGENT_TOOLS.map((tool) => [tool.name, listedTool(tool)]));

describe("the tool listing", () => {
  it("marks messages_post as always loaded, because the turn cannot end without it", () => {
    expect(listing().get("messages_post")).toMatchObject({
      _meta: { [ALWAYS_LOAD_META]: true },
    });
  });

  it("marks nothing else, so the rest stay behind tool search", () => {
    const marked = [...listing()]
      .filter(([, listed]) => "_meta" in listed)
      .map(([name]) => name);
    expect(marked).toEqual(["messages_post"]);
  });

  it("omits _meta rather than sending it empty on a deferred tool", () => {
    const tasksGet = agentToolByName("tasks_get");
    expect(tasksGet).toBeDefined();
    expect(
      tasksGet === undefined ? {} : Object.keys(listedTool(tasksGet))
    ).toEqual(["description", "inputSchema", "name"]);
  });

  it("carries the name, description and input schema of every tool", () => {
    for (const tool of AGENT_TOOLS) {
      expect(listedTool(tool)).toMatchObject({
        description: tool.description,
        inputSchema: tool.inputJsonSchema,
        name: tool.name,
      });
    }
  });
});
