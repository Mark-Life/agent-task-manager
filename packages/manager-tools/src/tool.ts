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
  "ManagerTools.ToolFailed",
  { detail: Schema.String, tool: Schema.String }
) {
  override get message() {
    return `${this.tool} — ${this.detail}`;
  }
}

/** One tool as the server lists it and calls it, with its input already erased. */
export interface ManagerTool {
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
}

/**
 * A schema as the JSON Schema an MCP client reads.
 *
 * Two shapes have to be undone. A named request schema generates as a `$ref` to
 * its own definition, and MCP requires the root of a tool's input to be an
 * object — a client that reads `{ $ref: … }` rejects the tool. And the
 * definitions live beside the document, with nowhere to be resolved from once
 * the tool listing is on the wire, so they are carried inside it under `$defs`.
 */
export const toolInputJsonSchema = (
  schema: Schema.Top
): JsonSchema.JsonSchema => {
  const document = JsonSchema.resolveTopLevel$ref(
    Schema.toJsonSchemaDocument(schema)
  );
  const root = objectRoot(document.schema);
  return Object.keys(document.definitions).length === 0
    ? root
    : { ...root, $defs: document.definitions };
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
  readonly description: string;
  readonly endpoint: string;
  readonly input: S;
  readonly name: string;
  readonly run: (call: {
    readonly client: GatewayClient;
    readonly input: S["Type"];
  }) => Effect.Effect<unknown, unknown>;
}): ManagerTool => ({
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
});
