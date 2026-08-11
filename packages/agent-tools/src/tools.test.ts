/**
 * What the tool table promises, asserted without a gateway.
 *
 * These are the claims a wrong edit breaks silently: a renamed tool (an MCP
 * client caches the listing, so a rename is a model calling a name that no
 * longer exists), an input schema that stopped being an object (an MCP client
 * refuses the tool outright), a tool pointed at an endpoint other than the one
 * it documents, and a failure rendered as a stack instead of a sentence.
 *
 * Two of them are about size rather than correctness, and are here because
 * everything this file describes is in the prompt of every turn: a definition
 * carried under `$defs` that no `$ref` reaches is bytes a client cannot use,
 * and a tool listed to a role whose credential refuses it on every call is a
 * schema bought with a `403`. Both are invisible to a test that only asks
 * whether the table works.
 *
 * The calls themselves are covered by the check script against a real gateway —
 * a mocked HTTP client would prove only that this file agrees with itself.
 * Which of them a worker is actually refused is checked there too, against a
 * real token, because that is the fact the listing is filtered on.
 */

import { describe, expect, it } from "bun:test";
import { TaskCreate } from "@workspace/api";
import { Schema } from "effect";
import { describeFailure, ToolFailed, toolInputJsonSchema } from "./tool";
import { AGENT_TOOLS, agentToolByName, agentToolsFor } from "./tools";

/** The names the manager's rules and the tool table both spell out. */
const EXPECTED_NAMES = [
  "projects_list",
  "projects_create",
  "tasks_list",
  "tasks_get",
  "tasks_create",
  "tasks_edit",
  "tasks_move",
  "tasks_delete",
  "messages_list",
  "messages_post",
  "runs_status",
  "runs_stop",
  "runs_rerun",
  "artifacts_list",
  "artifacts_read",
  "threads_list",
  "threads_get",
  "threads_messages",
  "threads_runs",
] as const;

/** Which gateway operation each tool is. Restated here on purpose: two spellings that must agree. */
const EXPECTED_ENDPOINTS: Readonly<Record<string, string>> = {
  artifacts_list:
    "GET /tasks/:taskId/artifacts | GET /projects/:projectId/artifacts",
  artifacts_read: "GET /tasks/:taskId/artifacts/:artifactId/content",
  messages_list: "GET /tasks/:taskId/messages",
  messages_post: "POST /tasks/:taskId/messages",
  projects_create: "POST /projects",
  projects_list: "GET /projects",
  runs_rerun: "POST /tasks/:taskId/commands/rerun",
  runs_status: "GET /tasks/:taskId/runs[/:runId]",
  runs_stop: "POST /tasks/:taskId/commands/stop",
  tasks_create: "POST /tasks",
  tasks_delete: "DELETE /tasks/:taskId",
  tasks_edit: "PATCH /tasks/:taskId",
  tasks_get: "GET /tasks/:taskId",
  tasks_list: "GET /tasks",
  tasks_move: "POST /tasks/:taskId/status",
  threads_get: "GET /threads/:threadId",
  threads_list: "GET /threads",
  threads_messages: "GET /threads/:threadId/messages",
  threads_runs: "GET /threads/:threadId/runs",
};

/** The tools that address one task, and therefore must take a `taskId`. */
const TASK_SCOPED = [
  "artifacts_list",
  "artifacts_read",
  "messages_list",
  "messages_post",
  "runs_rerun",
  "runs_status",
  "runs_stop",
  "tasks_delete",
  "tasks_edit",
  "tasks_get",
  "tasks_move",
] as const;

/** The tools that address one conversation, and therefore must take a `threadId`. */
const THREAD_SCOPED = [
  "threads_get",
  "threads_messages",
  "threads_runs",
] as const;

/**
 * The three a worker's credential is refused on whatever it passes, and
 * therefore the three it is not told about. Restated here on purpose, for the
 * reason `EXPECTED_ENDPOINTS` is: the table derives this from the endpoints,
 * and a derivation nobody pinned is a filter that can quietly widen.
 */
const REFUSED_TO_A_WORKER = [
  "projects_create",
  "tasks_create",
  "tasks_delete",
] as const;

/** The definitions a schema carries, and the ones something inside it points at. */
const definitionsOf = (schema: ReturnType<typeof toolInputJsonSchema>) => {
  const carried = Object.keys((schema.$defs ?? {}) as Record<string, unknown>);
  const text = JSON.stringify(schema);
  return {
    carried,
    reached: carried.filter((name) =>
      text.includes(`"$ref":"#/$defs/${name}"`)
    ),
  };
};

/** The fields of a tool's input schema, as the object an MCP client is handed. */
const propertiesOf = (name: string): Record<string, unknown> => {
  const properties = agentToolByName(name)?.inputJsonSchema.properties;
  return typeof properties === "object" && properties !== null
    ? { ...properties }
    : {};
};

describe("the agent tool table", () => {
  it("is exactly the eighteen operations, in the documented order", () => {
    expect(AGENT_TOOLS.map((tool) => tool.name)).toEqual([...EXPECTED_NAMES]);
  });

  it("has no duplicate names", () => {
    const names = new Set(AGENT_TOOLS.map((tool) => tool.name));
    expect(names.size).toBe(AGENT_TOOLS.length);
  });

  it("maps each tool to the endpoint it documents", () => {
    for (const tool of AGENT_TOOLS) {
      expect(tool.endpoint).toBe(EXPECTED_ENDPOINTS[tool.name] ?? "");
    }
  });

  it("describes every tool, because the description is all a model sees", () => {
    for (const tool of AGENT_TOOLS) {
      expect(tool.description.length).toBeGreaterThan(0);
    }
  });

  it("presents every input as a JSON Schema object", () => {
    for (const tool of AGENT_TOOLS) {
      expect(tool.inputJsonSchema.type).toBe("object");
    }
  });

  it("takes a taskId on every task-scoped tool", () => {
    for (const name of TASK_SCOPED) {
      expect(Object.keys(propertiesOf(name))).toContain("taskId");
    }
  });

  it("takes a threadId on every conversation-scoped tool", () => {
    for (const name of THREAD_SCOPED) {
      expect(Object.keys(propertiesOf(name))).toContain("threadId");
    }
  });

  it("offers exactly one delete, and it is a task", () => {
    const deletes = AGENT_TOOLS.filter((tool) =>
      tool.endpoint.startsWith("DELETE ")
    );
    expect(deletes.map((tool) => tool.name)).toEqual(["tasks_delete"]);
  });

  it("says in the delete's own description what goes with the task", () => {
    const remove = agentToolByName("tasks_delete");
    expect(remove?.description).toContain("no undo");
    expect(remove?.description).toContain("confirm");
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

  /**
   * A project's shared folder is where a research task leaves a document for the
   * next task, and a tool that could only address a task made that document
   * reachable only by somebody who already knew its path.
   */
  it("lets the artifact listing name a project instead of a task", () => {
    expect([...Object.keys(propertiesOf("artifacts_list"))].sort()).toEqual([
      "projectId",
      "taskId",
    ]);
    expect(agentToolByName("artifacts_list")?.description).toContain(
      "projectId"
    );
  });

  it("answers an unknown name with nothing rather than a guess", () => {
    expect(agentToolByName("tasks_archive")).toBeUndefined();
  });
});

/**
 * Every character of a tool's input schema is in the prompt of every turn that
 * is shown the tool, so a definition nothing can follow is a cost with no
 * reader. Resolving the top-level `$ref` inlines the named schema into the root
 * and leaves the definition behind it — `tasks_create` used to ship its whole
 * schema twice that way.
 */
describe("the input schema of a tool", () => {
  it("carries no definition nothing in it points at", () => {
    for (const tool of AGENT_TOOLS) {
      const { carried, reached } = definitionsOf(tool.inputJsonSchema);
      expect([tool.name, carried]).toEqual([tool.name, reached]);
    }
  });

  it("still says everything the request schema said", () => {
    expect([...Object.keys(propertiesOf("tasks_create"))].sort()).toEqual(
      [...Object.keys(TaskCreate.fields)].sort()
    );
  });

  it("keeps a definition two fields share, rather than pruning it", () => {
    const shared = toolInputJsonSchema(
      Schema.Struct({ one: TaskCreate, two: TaskCreate })
    );
    expect(definitionsOf(shared).carried).toEqual(["TaskCreate"]);
  });

  it("keeps one reached only through another definition", () => {
    const outer = Schema.Struct({ inner: TaskCreate }).annotate({
      identifier: "Outer",
    });
    const through = toolInputJsonSchema(Schema.Struct({ outer }));
    expect(definitionsOf(through).carried.sort()).toEqual([
      "Outer",
      "TaskCreate",
    ]);
  });
});

/**
 * Which tools a role is told about.
 *
 * A worker's token is bound to one task, so a write on no task at all is
 * refused as `unscoped_route` however the call is written, and erasing a task
 * is refused on the actor. Three tools are therefore a schema in every worker's
 * prompt and a `403` every time one is called. What is filtered is the listing
 * and only the listing: `AGENT_TOOLS` is still one table and the gateway still
 * answers every name in it.
 */
describe("the tools a role is listed", () => {
  it("gives a manager the whole table", () => {
    expect(agentToolsFor("manager")).toEqual(AGENT_TOOLS);
  });

  it("leaves a worker the ones its binding can never reach", () => {
    const listed = agentToolsFor("worker").map((tool) => tool.name);
    expect(listed).toEqual(
      AGENT_TOOLS.map((tool) => tool.name).filter(
        (name) => !REFUSED_TO_A_WORKER.includes(name as never)
      )
    );
  });

  it("hides exactly those three and nothing that reads", () => {
    const hidden = AGENT_TOOLS.filter((tool) => !tool.reachedByWorker);
    expect(hidden.map((tool) => tool.name)).toEqual([...REFUSED_TO_A_WORKER]);
    for (const tool of hidden) {
      expect([tool.name, tool.endpoint.startsWith("GET ")]).toEqual([
        tool.name,
        false,
      ]);
    }
  });

  it("still lists every write a run makes on its own card", () => {
    const listed = new Set(agentToolsFor("worker").map((tool) => tool.name));
    for (const name of [
      "messages_post",
      "tasks_edit",
      "tasks_move",
      "runs_stop",
      "runs_rerun",
    ]) {
      expect([name, listed.has(name)]).toEqual([name, true]);
    }
  });

  /**
   * The listing is not the authorization. A worker whose model calls a hidden
   * name — off a cached listing, or because the rules quote it — must reach the
   * gateway and be told `unscoped_route`, which is the real rule, rather than
   * this process inventing that the board no longer has the tool.
   */
  it("finds a hidden tool by name anyway, so the gateway answers it", () => {
    for (const name of REFUSED_TO_A_WORKER) {
      expect(agentToolByName(name)?.name).toBe(name);
    }
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
