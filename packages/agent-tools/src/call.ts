/**
 * Running one tool, with no opinion about the protocol that asked for it.
 *
 * There are two ways a provider reaches this table now — an MCP server over
 * stdio for the vendors that speak MCP, and a Pi extension for the one that
 * does not — and the rule they have to agree on is what a tool call *is*: look
 * the name up, decode the arguments, make the request, and come back with one
 * string and whether that string is the answer or the reason there isn't one.
 * Two copies of that would be two answers to "what happens when a worker calls
 * a manager's tool", which is exactly the kind of thing that drifts.
 *
 * **A failure is a value, not a throw.** Every ending — a refused command, a
 * 404, a connection refused, a defect — comes back as {@link ToolAnswer} with
 * `isError` set and one readable line in `text`. A model shown a stack either
 * narrates it to a person or invents a cause; a model shown "NotFound: no task
 * with that id" can say so and carry on. How that answer is delivered is the
 * protocol's business: MCP carries the flag on the result, and a Pi tool has to
 * throw to raise it.
 */

import type { RunRole } from "@workspace/domain";
import { Cause, Effect, Exit } from "effect";
import type { GatewayClient } from "./client";
import type { ToolFailed } from "./tool";
import { agentToolByName, agentToolsFor } from "./tools";

/** What one tool call produced: the text, and whether the text is what went wrong. */
export interface ToolAnswer {
  readonly isError: boolean;
  readonly text: string;
}

/** A failed call as one line: the tool's own message when it has one, the cause otherwise. */
const describeCause = (cause: Cause.Cause<ToolFailed>) => {
  const failure = Cause.findErrorOption(cause);
  return failure._tag === "Some" ? failure.value.message : Cause.pretty(cause);
};

/**
 * One tool call, always succeeding.
 *
 * A tool the client does not know about is answered rather than thrown: clients
 * cache tool listings, and a model calling a name that has moved deserves to be
 * told which names exist.
 *
 * **The role narrows what is listed and never what is called.** A name in the
 * table is looked up and run whatever role asked for it, so a worker that calls
 * a tool its listing left out gets the gateway's own refusal — `Forbidden:
 * unscoped_route`, which says what the rule is — rather than this file's "no
 * such tool", which would say the board had changed. The names offered back
 * after a genuine miss are that role's, because those are the ones worth
 * trying.
 */
export const callAgentTool = (options: {
  readonly args: unknown;
  readonly client: GatewayClient;
  readonly name: string;
  readonly role: RunRole;
}): Effect.Effect<ToolAnswer> => {
  const tool = agentToolByName(options.name);
  if (tool === undefined) {
    const offered = agentToolsFor(options.role).map((each) => each.name);
    return Effect.succeed({
      isError: true,
      text: `no such tool: ${options.name}. Available: ${offered.join(", ")}`,
    });
  }
  return Effect.exit(tool.call(options.client, options.args)).pipe(
    Effect.map((exit) =>
      Exit.isSuccess(exit)
        ? { isError: false, text: exit.value }
        : { isError: true, text: describeCause(exit.cause) }
    )
  );
};
