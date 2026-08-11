/**
 * What one manager tool is, and how a failure becomes a sentence.
 *
 * A tool is a thin wrapper over exactly one gateway operation: an input schema,
 * the call, and the JSON that comes back. It deliberately holds no logic of its
 * own — anything a tool decided for itself would be a rule the board does not
 * enforce, reachable only through the chat.
 *
 * The input schema is the API's own, so the JSON Schema an agent reads is
 * generated from the contract rather than described beside it. The declared
 * `endpoint` is documentation with teeth: it is asserted in the tests, so a tool
 * that quietly starts calling something else stops matching what it says it is.
 *
 * **Every failure comes back as a readable line, never as a stack.** A model
 * shown a stack trace either narrates it to a person or invents a cause; a model
 * shown "NotFound: no task with that id in this workspace" can say so and move
 * on. That is why the error channel of a tool is one string and why the rejected
 * reason on a refused run command reaches the caller intact.
 */

import { Effect, JsonSchema, Schema } from "effect";
import type { GatewayClient } from "./client";

/** A tool call the gateway refused, or a request that never became one. */
export class ToolFailed extends Schema.TaggedErrorClass<ToolFailed>()(
  "AgentTools.ToolFailed",
  { detail: Schema.String, tool: Schema.String }
) {
  override get message() {
    return `${this.tool} — ${this.detail}`;
  }
}

/** One tool as the server lists it and calls it, with its input already erased. */
export interface AgentTool {
  /**
   * Whether this tool is kept out of the client's deferred set and written into
   * every prompt. False for all but the one tool a turn cannot end without.
   */
  readonly alwaysLoad: boolean;
  /** Decodes the arguments, calls the gateway, and renders the answer as text. */
  readonly call: (
    client: GatewayClient,
    args: unknown
  ) => Effect.Effect<string, ToolFailed>;
  readonly description: string;
  /** The single gateway operation this tool is, e.g. `GET /tasks/:taskId`. */
  readonly endpoint: string;
  /** The input schema, kept for tests and for anything that wants to decode by itself. */
  readonly input: Schema.Top;
  /** The same schema as JSON Schema, which is what an MCP client is handed. */
  readonly inputJsonSchema: JsonSchema.JsonSchema;
  readonly name: string;
  /**
   * Whether a worker's credential can ever succeed at this operation. Derived
   * from {@link withinWorkerBinding} and the one refusal that lives past the
   * binding; see the note there.
   */
  readonly reachedByWorker: boolean;
}

/** How a `$ref` names something in the document's own definitions, in Draft 2020-12. */
const DEFINITION_REF = "#/$defs/";

/**
 * The definitions named by `$ref` anywhere inside one schema node.
 *
 * One level only — the closure over what those definitions themselves reference
 * is {@link referencedDefinitions}. Walks arrays and objects alike because a
 * `$ref` is legal wherever a schema is, which in practice is inside
 * `properties`, `items`, `anyOf` and `$defs`.
 */
const refNamesIn = (node: unknown, into: Set<string>): Set<string> => {
  if (Array.isArray(node)) {
    for (const item of node) {
      refNamesIn(item, into);
    }
    return into;
  }
  if (typeof node !== "object" || node === null) {
    return into;
  }
  for (const [key, value] of Object.entries(node)) {
    if (key === "$ref" && typeof value === "string") {
      if (value.startsWith(DEFINITION_REF)) {
        into.add(value.slice(DEFINITION_REF.length));
      }
    } else {
      refNamesIn(value, into);
    }
  }
  return into;
};

/**
 * The definitions this root actually reaches, following `$ref`s through the
 * definitions themselves.
 *
 * Transitive rather than one pass: a kept definition may `$ref` a second one,
 * and shipping the first without the second is a listing with a dangling
 * pointer — worse than the duplication this removes.
 */
const referencedDefinitions = (
  root: JsonSchema.JsonSchema,
  definitions: JsonSchema.Definitions
): JsonSchema.Definitions => {
  const kept: Record<string, JsonSchema.JsonSchema> = {};
  const pending = [...refNamesIn(root, new Set<string>())];
  while (pending.length > 0) {
    const name = pending.pop();
    if (name === undefined || name in kept) {
      continue;
    }
    const definition = definitions[name];
    if (definition === undefined) {
      continue;
    }
    kept[name] = definition;
    pending.push(...refNamesIn(definition, new Set<string>()));
  }
  return kept;
};

/**
 * A schema as the JSON Schema an MCP client reads.
 *
 * Two shapes have to be undone. A named request schema generates as a `$ref` to
 * its own definition, and MCP requires the root of a tool's input to be an
 * object — a client that reads `{ $ref: … }` rejects the tool. And the
 * definitions live beside the document, with nowhere to be resolved from once
 * the tool listing is on the wire, so the ones the root still points at are
 * carried inside it under `$defs`.
 *
 * **Only the ones it still points at.** Resolving the top-level `$ref` inlines
 * the named definition into the root and leaves the definition itself in the
 * pool with nothing referring to it — an exact second copy of the schema
 * directly above it. Two tools generated that way, and their orphans were
 * 1,409 of the tool table's 13,513 characters, `tasks_create` alone 1,068 of
 * them. Every one of those characters is in the prompt of every turn, and none
 * of them can be reached by a client reading the listing. So the pool is pruned
 * to what the root can follow, which is a no-op for a schema that genuinely
 * shares a definition and removes the whole of it for one that does not.
 */
export const toolInputJsonSchema = (
  schema: Schema.Top
): JsonSchema.JsonSchema => {
  const document = JsonSchema.resolveTopLevel$ref(
    Schema.toJsonSchemaDocument(schema)
  );
  const root = objectRoot(document.schema);
  const carried = referencedDefinitions(root, document.definitions);
  return Object.keys(carried).length === 0 ? root : { ...root, $defs: carried };
};

/**
 * The root as an object schema.
 *
 * A struct with no fields generates as "any object or array", because that is
 * what no constraints means — but a tool taking no arguments still has to say
 * "an object with no properties" or the client has nothing to send. Every input
 * here is a struct, so this is that one case spelled out.
 */
const objectRoot = (schema: JsonSchema.JsonSchema): JsonSchema.JsonSchema =>
  schema.type === "object"
    ? schema
    : { additionalProperties: false, properties: {}, type: "object" };

/**
 * A failure as one line a model can act on.
 *
 * Typed API failures (`NotFound`, `IllegalTransition`, …) carry their fields on
 * the instance, so the tag plus the fields is the whole story; a transport
 * failure carries its own message. Anything else is stringified rather than
 * dropped, because a silent tool is worse than an ugly one.
 */
export const describeFailure = (failure: unknown): string => {
  if (typeof failure === "object" && failure !== null) {
    const tag = "_tag" in failure ? String(failure._tag) : null;
    const fields = jsonFieldsOf(failure);
    const text =
      failure instanceof Error && failure.message.length > 0
        ? failure.message
        : fields;
    return tag === null ? text : `${tag}: ${text}`;
  }
  return String(failure);
};

/** The own enumerable fields of a failure, minus its tag, as compact JSON. */
const jsonFieldsOf = (failure: object) => {
  try {
    return JSON.stringify(failure, (key, value) =>
      key === "_tag" ? undefined : value
    );
  } catch {
    return String(failure);
  }
};

/** The method whose endpoints ask for `read`, which a run's token holds over the whole board. */
const READ_METHOD = "GET ";

/** The path parameter the contract nests every task-owned route below. */
const TASK_PARAM = ":taskId";

/** Where a tool that is two endpoints separates them, as `endpoint` spells it. */
const ENDPOINT_SEPARATOR = " | ";

/**
 * Whether a worker's binding lets this endpoint through, read off the endpoint
 * the tool already declares.
 *
 * Derived rather than listed, because the gateway's own check is exactly this
 * shape: `checkBinding` in `apps/gateway/src/auth/principal.ts` lets a bound
 * token through when the scope required is `read`, refuses `unscoped_route` on
 * a write with no `:taskId` in the path, and compares the two ids otherwise. So
 * a `GET` is reachable, a write nested under `:taskId` is reachable on the
 * run's own task, and a write that is not about one task never is. A tool that
 * is two endpoints has to clear both, since either one may be the call.
 *
 * The per-call half — a write aimed at *somebody else's* task — is not a
 * property of the tool and is not decided here. It stays where it is, on the
 * request.
 */
const withinWorkerBinding = (endpoint: string) =>
  endpoint
    .split(ENDPOINT_SEPARATOR)
    .every((one) => one.startsWith(READ_METHOD) || one.includes(TASK_PARAM));

/** How many spaces the rendered JSON is indented by — read by a model, not a parser. */
const RESULT_INDENT = 2;

/** A gateway answer as the text of a tool result: JSON, or the string it already is. */
const renderResult = (value: unknown) =>
  typeof value === "string"
    ? value
    : (JSON.stringify(value, null, RESULT_INDENT) ?? "null");

/**
 * One tool over one gateway operation.
 *
 * The input type is inferred from the schema and erased on the way out, which
 * is what lets fourteen differently-shaped tools live in one array while each
 * handler still sees its own decoded input.
 */
export const defineTool = <
  S extends Schema.Top & { readonly DecodingServices: never },
>(options: {
  /** See `AgentTool.alwaysLoad`. Deferred unless a tool asks not to be. */
  readonly alwaysLoad?: boolean;
  readonly description: string;
  readonly endpoint: string;
  readonly input: S;
  readonly name: string;
  /**
   * A refusal a worker meets *past* the binding, which the endpoint therefore
   * cannot show. Set on the one operation the domain answers on the actor
   * rather than on the task; everything else leaves it alone.
   */
  readonly refusedToWorker?: boolean;
  readonly run: (call: {
    readonly client: GatewayClient;
    readonly input: S["Type"];
  }) => Effect.Effect<unknown, unknown>;
}): AgentTool => ({
  alwaysLoad: options.alwaysLoad ?? false,
  call: (client, args) =>
    Schema.decodeUnknownEffect(options.input)(args ?? {}).pipe(
      Effect.flatMap((input) => options.run({ client, input })),
      Effect.map(renderResult),
      Effect.mapError(
        (failure) =>
          new ToolFailed({
            detail: describeFailure(failure),
            tool: options.name,
          })
      )
    ),
  description: options.description,
  endpoint: options.endpoint,
  input: options.input,
  inputJsonSchema: toolInputJsonSchema(options.input),
  name: options.name,
  reachedByWorker:
    withinWorkerBinding(options.endpoint) && options.refusedToWorker !== true,
});
