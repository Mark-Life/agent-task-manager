/**
 * The intents anyone may write and only the orchestrator acts on.
 *
 * Container lifecycle has one owner. A human, the manager and an agent all
 * steer through these rows, which is what keeps every intervention attributable
 * and stops a second door into starting and stopping containers from existing.
 * Reordering the queue is deliberately not here: it is an ordinary write to the
 * task's rank.
 */

import {
  RunCommand as DomainRunCommand,
  RunId,
  RunTrigger,
} from "@workspace/domain";
import { Schema } from "effect";

/** A queued or settled intent, exactly as the store holds it. */
export const RunCommand = DomainRunCommand.annotate({
  identifier: "RunCommand",
});

export interface RunCommand extends Schema.Schema.Type<typeof RunCommand> {}

/**
 * Which attempt an intent is aimed at. Absent targets whichever run is live,
 * which is what a Stop button means; naming a run is for the case where the
 * caller has one in hand and wants to be sure it is still that one.
 */
export const RunTarget = Schema.Struct({
  runId: Schema.optionalKey(RunId),
}).annotate({ identifier: "RunTarget" });

export interface RunTarget extends Schema.Schema.Type<typeof RunTarget> {}

/**
 * Spawn a session without moving the task. This is how research from `backlog`
 * happens: run creation stays solely with the orchestrator, and the request
 * rides the channel that already exists rather than a second path into a
 * container.
 */
export const StartSessionRequest = Schema.Struct({
  trigger: RunTrigger,
}).annotate({ identifier: "StartSessionRequest" });

export interface StartSessionRequest
  extends Schema.Schema.Type<typeof StartSessionRequest> {}
