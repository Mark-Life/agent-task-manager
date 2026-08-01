import { Schema } from "effect";
import { commandActorFields } from "./actor";
import { RunCommandStatus, RunTrigger } from "./enums";
import { RunCommandId, RunId, TaskId } from "./ids";
import { recordFields, Timestamp } from "./primitives";

/** Kill the container. */
const StopCommand = Schema.Struct({ kind: Schema.tag("stop") });

/**
 * Resume the same session with everything said since as its next prompt. Not a
 * back door into the status machine: the orchestrator rejects a rerun on a task
 * that is not `in_progress`, so a live run always implies that column.
 */
const RerunCommand = Schema.Struct({ kind: Schema.tag("rerun") });

/**
 * Spawn a session without moving the task. This is how research from `backlog`
 * happens: run creation stays solely with the orchestrator and the request
 * rides the notify channel that already exists, so there is no second path into
 * a container.
 */
const StartSessionCommand = Schema.Struct({
  kind: Schema.tag("start_session"),
  trigger: RunTrigger,
});

/** What a run command asks for, keyed by its kind. Split across the `kind` column and the jsonb blob, as run events are. */
export const RunCommandPayload = Schema.Union([
  StopCommand,
  RerunCommand,
  StartSessionCommand,
]).pipe(Schema.toTaggedUnion("kind"));
export type RunCommandPayload = typeof RunCommandPayload.Type;

/**
 * An intent anyone may write and only the orchestrator acts on. Keeping one
 * owner of container lifecycle is the point: a human, the manager and an agent
 * all steer through the same rows, and every intervention is attributable.
 */
export const RunCommand = Schema.Struct({
  ...recordFields,
  ...commandActorFields,
  consumedAt: Schema.NullOr(Timestamp),
  id: RunCommandId,
  payload: RunCommandPayload,
  /** "No live run" and "task not in progress" are outcomes, not silence. */
  rejectedReason: Schema.NullOr(Schema.String),
  /** Null targets whichever run is live. */
  runId: Schema.NullOr(RunId),
  status: RunCommandStatus,
  /** A command can target a task that has no run yet. */
  taskId: TaskId,
});

export interface RunCommand extends Schema.Schema.Type<typeof RunCommand> {}
