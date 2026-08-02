/**
 * Steering a run, through the queue the orchestrator reads.
 *
 * Nothing here touches a container. Each operation writes an intent and returns
 * it, and the orchestrator acts — which is what keeps one owner of container
 * lifecycle while a person, the manager and an agent all steer through the same
 * rows. A refused intent comes back with a reason on it, because "no live run"
 * and "task not in progress" are outcomes the asker is entitled to see.
 *
 * Three verbs rather than one endpoint taking a kind, so each arrives at
 * Executor as a tool a reader can tell apart without opening a schema.
 */

import { TaskId } from "@workspace/domain";
import { Schema } from "effect";
import {
  HttpApiEndpoint,
  HttpApiGroup,
  OpenApi,
} from "effect/unstable/httpapi";
import { InvalidInput, NotFound } from "../errors";
import {
  RunCommand,
  RunTarget,
  StartSessionRequest,
} from "../schemas/run-command";
import { ReadAccess, TaskWriteAccess } from "../security";

/** Every intervention on a task, newest first, whether it was acted on or refused. */
const list = HttpApiEndpoint.get("list", "/tasks/:taskId/commands", {
  error: NotFound,
  params: { taskId: TaskId },
  success: Schema.Array(RunCommand),
})
  .middleware(ReadAccess)
  .annotate(OpenApi.Summary, "List the intents queued on a task");

/**
 * Kill the container. A second identical intent while the first is pending
 * returns the one already queued, so a double-clicked Stop does not land a
 * second row that could only ever be rejected as noise.
 */
const stop = HttpApiEndpoint.post("stop", "/tasks/:taskId/commands/stop", {
  error: NotFound,
  params: { taskId: TaskId },
  payload: RunTarget,
  success: RunCommand,
})
  .middleware(TaskWriteAccess)
  .annotate(OpenApi.Summary, "Ask the orchestrator to stop a run");

/**
 * Resume the same session with everything said since as its next prompt. Not a
 * back door into the status machine: a rerun on a task that is not in progress
 * is rejected, so a live run always implies that column.
 */
const rerun = HttpApiEndpoint.post("rerun", "/tasks/:taskId/commands/rerun", {
  error: NotFound,
  params: { taskId: TaskId },
  payload: RunTarget,
  success: RunCommand,
})
  .middleware(TaskWriteAccess)
  .annotate(OpenApi.Summary, "Ask the orchestrator to rerun a task");

/**
 * Spawn a session without moving the task — how research from `backlog`
 * happens. Run creation stays solely with the orchestrator; this is the request
 * for one, not a second path into a container.
 */
const startSession = HttpApiEndpoint.post(
  "startSession",
  "/tasks/:taskId/commands/start-session",
  {
    error: [InvalidInput, NotFound],
    params: { taskId: TaskId },
    payload: StartSessionRequest,
    success: RunCommand,
  }
)
  .middleware(TaskWriteAccess)
  .annotate(OpenApi.Summary, "Ask the orchestrator to start a session");

/** Intents anyone may write and only the orchestrator acts on. */
export class RunCommandsGroup extends HttpApiGroup.make("runCommands")
  .add(list, stop, rerun, startSession)
  .annotate(
    OpenApi.Description,
    "Run commands: stop, rerun and start-session, queued for the orchestrator."
  ) {}
