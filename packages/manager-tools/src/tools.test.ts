/**
 * What the tool table promises, asserted without a gateway.
 *
 * These are the claims a wrong edit breaks silently: a renamed tool (an MCP
 * client caches the listing, so a rename is a model calling a name that no
 * longer exists), an input schema that stopped being an object (an MCP client
 * refuses the tool outright), a tool pointed at an endpoint other than the one
 * it documents, and a failure rendered as a stack instead of a sentence.
 *
 * The calls themselves are covered by the check script against a real gateway —
 * a mocked HTTP client would prove only that this file agrees with itself.
 */

import { describe, expect, it } from "bun:test";
import { describeFailure, ToolFailed } from "./tool";
import { MANAGER_TOOLS, managerToolByName } from "./tools";

/** The names the manager's rules and the design table both spell out. */
const EXPECTED_NAMES = [
  "projects_list",
  "projects_create",
  "tasks_list",
  "tasks_get",
  "tasks_create",
  "tasks_edit",
  "tasks_move",
  "comments_list",
  "comments_add",
  "runs_status",
  "runs_stop",
  "runs_rerun",
  "artifacts_list",
  "artifacts_read",
] as const;

/** Which gateway operation each tool is. Restated here on purpose: two spellings that must agree. */
const EXPECTED_ENDPOINTS: Readonly<Record<string, string>> = {
  artifacts_list: "GET /tasks/:taskId/artifacts",
  artifacts_read: "GET /tasks/:taskId/artifacts/:artifactId/content",
  comments_add: "POST /tasks/:taskId/comments",
  comments_list: "GET /tasks/:taskId/comments",
  projects_create: "POST /projects",
  projects_list: "GET /projects",
  runs_rerun: "POST /tasks/:taskId/commands/rerun",
  runs_status: "GET /tasks/:taskId/runs[/:runId]",
  runs_stop: "POST /tasks/:taskId/commands/stop",
  tasks_create: "POST /tasks",
  tasks_edit: "PATCH /tasks/:taskId",
  tasks_get: "GET /tasks/:taskId",
  tasks_list: "GET /tasks",
  tasks_move: "POST /tasks/:taskId/status",
};

/** The tools that address one task, and therefore must take a `taskId`. */
const TASK_SCOPED = [
  "artifacts_list",
  "artifacts_read",
  "comments_add",
  "comments_list",
  "runs_rerun",
  "runs_status",
  "runs_stop",
  "tasks_edit",
  "tasks_get",
  "tasks_move",
] as const;

/** The fields of a tool's input schema, as the object an MCP client is handed. */
const propertiesOf = (name: string): Record<string, unknown> => {
  const properties = managerToolByName(name)?.inputJsonSchema.properties;
  return typeof properties === "object" && properties !== null
    ? { ...properties }
    : {};
};

describe("the manager's tool table", () => {
  it("is exactly the fourteen operations, in the documented order", () => {
    expect(MANAGER_TOOLS.map((tool) => tool.name)).toEqual([...EXPECTED_NAMES]);
  });

  it("has no duplicate names", () => {
    const names = new Set(MANAGER_TOOLS.map((tool) => tool.name));
    expect(names.size).toBe(MANAGER_TOOLS.length);
  });

  it("maps each tool to the endpoint it documents", () => {
    for (const tool of MANAGER_TOOLS) {
      expect(tool.endpoint).toBe(EXPECTED_ENDPOINTS[tool.name] ?? "");
    }
  });

  it("describes every tool, because the description is all a model sees", () => {
    for (const tool of MANAGER_TOOLS) {
      expect(tool.description.length).toBeGreaterThan(0);
    }
  });

  it("presents every input as a JSON Schema object", () => {
    for (const tool of MANAGER_TOOLS) {
      expect(tool.inputJsonSchema.type).toBe("object");
    }
  });

  it("takes a taskId on every task-scoped tool", () => {
    for (const name of TASK_SCOPED) {
      expect(Object.keys(propertiesOf(name))).toContain("taskId");
    }
  });

  it("offers no delete, because the manager's scope cannot reach one", () => {
    for (const tool of MANAGER_TOOLS) {
      expect(tool.endpoint.startsWith("DELETE ")).toBe(false);
    }
  });

  it("takes an optional runId on the run tools and nothing else", () => {
    for (const name of ["runs_status", "runs_stop", "runs_rerun"]) {
      expect([...Object.keys(propertiesOf(name))].sort()).toEqual([
        "runId",
        "taskId",
      ]);
    }
  });

  it("bounds what a listing or a read may ask for", () => {
    expect(JSON.stringify(propertiesOf("tasks_list").limit)).toContain(
      '"maximum":200'
    );
    expect(JSON.stringify(propertiesOf("artifacts_read").maxChars)).toContain(
      '"maximum":40000'
    );
  });

  it("answers an unknown name with nothing rather than a guess", () => {
    expect(managerToolByName("tasks_delete")).toBeUndefined();
  });
});

describe("a failed call", () => {
  it("reads as the tag and the fields a caller can act on", () => {
    const described = describeFailure({
      _tag: "NotFound",
      entity: "task",
      id: "t1",
    });
    expect(described).toContain("NotFound");
    expect(described).toContain("task");
  });

  it("prefers the message of a failure that carries one", () => {
    expect(describeFailure(new Error("connection refused"))).toContain(
      "connection refused"
    );
  });

  it("survives a failure that is not an object", () => {
    expect(describeFailure("connection refused")).toBe("connection refused");
  });

  it("names the tool that failed", () => {
    const failed = new ToolFailed({
      detail: "no such task",
      tool: "tasks_get",
    });
    expect(failed.message).toBe("tasks_get — no such task");
  });
});
