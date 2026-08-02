/**
 * Acting on what somebody asked the orchestrator to do.
 *
 * Anyone may write a `run_command` — a person in the dashboard, the manager
 * agent, an agent holding a task-scoped token — and only this module acts on
 * one. That is the whole design: container lifecycle has exactly one owner, so
 * a stop from a chat message and a stop from a button are the same row taking
 * the same path, and every intervention is attributable without anybody
 * remembering to record it.
 *
 * Three intents, and each of them has a refusal that is a real answer. "There is
 * no live run to stop", "a rerun needs the task in progress" and "a run is
 * already live" are things the asker is entitled to see, so a refused command is
 * `rejected` with the reason on its row rather than consumed and forgotten. That
 * is also why a handler that fails outright still writes a rejection: the row
 * has already been claimed, and a claimed command that says nothing is
 * indistinguishable from one that was never written.
 *
 * The two things this module cannot do itself are the two that belong to the
 * part of the loop holding the fibers: killing a container and starting a run.
 * Both arrive as {@link RunControl}, which the dispatcher provides — stopping a
 * container is interrupting the fiber inside `Sandbox.run`, and there is no
 * second door into creating a run.
 */

import { RunCommandRepo, RunEventRepo, RunRepo, TaskRepo } from "@workspace/db";
import type {
  RunCommand,
  RunCommandKind,
  RunId,
  RunTrigger,
  Task,
  TaskId,
  WorkspaceId,
} from "@workspace/domain";
import { isRunLive, RUN_COMMAND_KINDS } from "@workspace/domain";
import { boundedCounter } from "@workspace/telemetry";
import { Cause, Context, DateTime, Effect, Layer } from "effect";
import { describeFailure } from "./errors";

/**
 * Where the orchestrator's own run-event markers start numbering.
 *
 * A run event's `seq` is the ordinal of its line in the container's event file,
 * which is what makes re-ingesting that file collide row for row instead of
 * writing a second timeline. A `stopped` marker has no line — it is written on
 * the host, about a container that is being killed — so it numbers from far
 * above anything a file could reach. The column is a 32-bit integer and a run's
 * file is thousands of lines at the outside, so a billion is unreachable from
 * below and leaves a billion more above it.
 */
export const MARKER_SEQ_BASE = 1_000_000_000;

/** The one marker this module writes. A run is stopped at most once. */
export const STOPPED_SEQ = MARKER_SEQ_BASE;

/**
 * How many commands one pass drains. A person double-clicking Stop and a manager
 * agent in a loop both produce a burst, and a pass that drained an unbounded
 * queue would spend the interval on commands instead of on dispatch.
 */
const DEFAULT_MAX_PER_PASS = 32;

/**
 * The triggers a `start_session` may ask for. `status_change` belongs to the
 * dispatcher and `rerun` to its own command, so a session spawned by hand says
 * so on the run row rather than borrowing a provenance that is not its.
 */
const SPAWNABLE_TRIGGERS: readonly RunTrigger[] = ["manual", "research"];

/** What starting a run needs from the part of the loop that owns dispatch. */
export interface DispatchRequest {
  readonly taskId: TaskId;
  readonly trigger: RunTrigger;
  readonly workspaceId: WorkspaceId;
}

/** What killing a container needs. */
export interface StopRequest {
  readonly runId: RunId;
  readonly taskId: TaskId;
  readonly workspaceId: WorkspaceId;
}

/**
 * The two operations this module delegates. Both fail with `unknown` because
 * both are the far side of a seam: whatever went wrong there is classified by
 * `describeFailure` and lands on the command's rejection, and narrowing the type
 * here would mean restating the dispatcher's failure vocabulary in the module
 * that only reports it.
 */
export interface RunControlInterface {
  /** Starts a run on the task, honouring whatever the task says runs next. */
  readonly dispatch: (input: DispatchRequest) => Effect.Effect<void, unknown>;
  /**
   * Interrupts the fiber running this run's container, which is how a container
   * is torn down. Answers whether a live fiber was actually found — false means
   * the process was already gone, which is a fact worth recording rather than an
   * error.
   */
  readonly stop: (input: StopRequest) => Effect.Effect<boolean, unknown>;
}

/**
 * Container lifecycle, as the dispatcher implements it. Declared here and
 * provided there: this module decides *whether* something should be stopped or
 * started, and holds none of the fibers that make it happen.
 */
export class RunControl extends Context.Service<
  RunControl,
  RunControlInterface
>()("@workspace/orchestrator/RunControl") {}

/** What a claimed command turned into. */
export const COMMAND_RESULTS = ["acted", "rejected"] as const;

/** Acted on, or refused with a reason. There is no third answer. */
export type CommandResult = (typeof COMMAND_RESULTS)[number];

/** One command and what became of it, for the pass's log and its counters. */
export interface CommandOutcome {
  readonly command: RunCommand;
  /** Null on `acted`; the refusal on `rejected`, and the same text on the row. */
  readonly reason: string | null;
  readonly result: CommandResult;
}

/**
 * The bounded projection: interventions, by what was asked and whether it
 * happened. Six series, and no task or run id — those are on the rows the
 * command already wrote.
 */
const commandsHandled = boundedCounter("atm_run_commands_total", {
  description: "Run commands consumed by the orchestrator, by kind and result",
  tags: { kind: RUN_COMMAND_KINDS, result: COMMAND_RESULTS },
});

/** What one pass over the queue needs. */
export interface DrainInput {
  /** Defaults to {@link DEFAULT_MAX_PER_PASS}. */
  readonly maxPerPass?: number;
  readonly workspaceId: WorkspaceId;
}

/**
 * The queue consumer, built over whatever {@link RunControl} is in context.
 *
 * Exported as an effect and not only as a layer because the thing that
 * implements `RunControl` is the runtime, and the runtime is also the thing
 * that needs this: a layer would have the two waiting on each other. The
 * runtime builds its control record first and provides it here.
 */
export const makeRunCommands = Effect.gen(function* () {
  const commands = yield* RunCommandRepo;
  const control = yield* RunControl;
  const events = yield* RunEventRepo;
  const runs = yield* RunRepo;
  const tasks = yield* TaskRepo;

  /**
   * Writes the marker naming the command and who asked for it. Ordered last in
   * the timeline by construction: every ingested event's `seq` is a file line
   * ordinal, and this one is far above them all.
   */
  const appendStopped = (input: {
    readonly command: RunCommand;
    readonly runId: RunId;
  }) =>
    Effect.gen(function* () {
      const occurredAt = yield* DateTime.now;
      yield* events.append({
        occurredAt,
        payload: {
          commandId: input.command.id,
          kind: "stopped",
          requestedByKind: input.command.actorKind,
          ...(input.command.actorUserId === null
            ? {}
            : { requestedByUserId: input.command.actorUserId }),
        },
        runId: input.runId,
        seq: STOPPED_SEQ,
        taskId: input.command.taskId,
        workspaceId: input.command.workspaceId,
      });
    });

  /**
   * Closes the run out as interrupted, and treats "already closed" as done.
   *
   * The race is real and benign: interrupting the fiber makes the run
   * lifecycle's own exit handler close the row too, and whichever of the two
   * arrives second finds an outcome already written. A stop that reported a
   * failure because the run was already correctly marked interrupted would be a
   * refusal with nothing behind it.
   */
  const closeInterrupted = (input: {
    readonly runId: RunId;
    readonly workspaceId: WorkspaceId;
  }) =>
    runs
      .close({
        id: input.runId,
        outcome: "interrupted",
        workspaceId: input.workspaceId,
      })
      .pipe(
        Effect.catchTag("RunRepo.NotLive", () =>
          Effect.logInfo(
            `run ${input.runId} had already closed when the stop landed`
          )
        )
      );

  /**
   * Clears the retry stamp. An explicit intervention is the same signal a human
   * move into *in progress* carries — somebody has decided this should run — and
   * a rerun that silently sat out a backoff is a button that does nothing.
   * Guarded on the column, so an unparked task collects no audit row.
   */
  const unpark = (task: Task) =>
    task.parkedUntil === null
      ? Effect.void
      : tasks.update({
          fields: { parkedUntil: null },
          id: task.id,
          workspaceId: task.workspaceId,
        });

  /** The run a stop names, or the task's live one when it names none. */
  const stopTarget = (command: RunCommand) =>
    command.runId === null
      ? runs.liveForTask({
          taskId: command.taskId,
          workspaceId: command.workspaceId,
        })
      : runs.byId({ id: command.runId, workspaceId: command.workspaceId });

  const handleStop = Effect.fn("RunCommands.stop")(function* (
    command: RunCommand
  ) {
    const target = yield* stopTarget(command);
    if (target === null) {
      return "there is no live run on this task to stop";
    }
    if (!isRunLive(target)) {
      return `run ${target.id} is already ${target.status}`;
    }

    const killed = yield* control.stop({
      runId: target.id,
      taskId: target.taskId,
      workspaceId: command.workspaceId,
    });
    if (!killed) {
      yield* Effect.logWarning(
        `stop found no live container for run ${target.id} — closing the row anyway`
      );
    }

    yield* appendStopped({ command, runId: target.id });
    yield* closeInterrupted({
      runId: target.id,
      workspaceId: command.workspaceId,
    });
    return null;
  });

  /**
   * Resumes the task's session with everything said since as its next prompt —
   * which is the prompt builder's job, off the session's comment watermark, so
   * all this has to do is start the run.
   *
   * The status check is the reason this is not a back door into the board: a
   * rerun on a task that is not in progress would put a container on a card
   * nobody moved.
   */
  const handleRerun = Effect.fn("RunCommands.rerun")(function* (
    command: RunCommand
  ) {
    const task = yield* tasks.byId({
      id: command.taskId,
      workspaceId: command.workspaceId,
    });
    if (task.status !== "in_progress") {
      return `a rerun needs the task in progress, and it is in ${task.status}`;
    }
    const live = yield* runs.liveForTask({
      taskId: command.taskId,
      workspaceId: command.workspaceId,
    });
    if (live !== null) {
      return `run ${live.id} is already live on this task — stop it first`;
    }
    yield* unpark(task);
    yield* control.dispatch({
      taskId: command.taskId,
      trigger: "rerun",
      workspaceId: command.workspaceId,
    });
    return null;
  });

  /**
   * Spawns a session without moving the task, which is how research from the
   * backlog happens. No status check on purpose — that is the point of the
   * command — but still one run at a time, because two containers on one task
   * means two writers on one artifacts directory.
   */
  const handleStartSession = Effect.fn("RunCommands.startSession")(function* (
    command: RunCommand,
    trigger: RunTrigger
  ) {
    if (!SPAWNABLE_TRIGGERS.includes(trigger)) {
      return `a start_session cannot claim the ${trigger} trigger`;
    }
    const task = yield* tasks.byId({
      id: command.taskId,
      workspaceId: command.workspaceId,
    });
    const live = yield* runs.liveForTask({
      taskId: command.taskId,
      workspaceId: command.workspaceId,
    });
    if (live !== null) {
      return `run ${live.id} is already live on this task — stop it first`;
    }
    yield* unpark(task);
    yield* control.dispatch({
      taskId: command.taskId,
      trigger,
      workspaceId: command.workspaceId,
    });
    return null;
  });

  /** The refusal, or null where the command was acted on. */
  const handle = (command: RunCommand) => {
    switch (command.payload.kind) {
      case "stop":
        return handleStop(command);
      case "rerun":
        return handleRerun(command);
      default:
        return handleStartSession(command, command.payload.trigger);
    }
  };

  /**
   * Runs the handler and turns anything at all into a refusal. Defects included:
   * the command row is already consumed by the time a handler runs, so a thrown
   * value that escaped would leave an intent with no outcome on it — which is
   * exactly the silence this module exists to avoid.
   */
  const refusalOf = (command: RunCommand) =>
    handle(command).pipe(
      Effect.catchCause((cause) =>
        Effect.succeed(describeFailure(Cause.squash(cause)).errorMessage)
      )
    );

  const recordOutcome = (input: {
    readonly kind: RunCommandKind;
    readonly result: CommandResult;
  }) => commandsHandled.increment(input).pipe(Effect.ignoreCause);

  /**
   * Takes the oldest pending command and acts on it, or answers null when the
   * queue is empty. Claiming already consumed the row — that is the repository's
   * doing, so a command cannot be handed out twice and a stop cannot kill the
   * container that replaced the one it meant.
   */
  const consumeNext = Effect.fn("RunCommands.consumeNext")(function* (input: {
    readonly workspaceId: WorkspaceId;
  }) {
    const command = yield* commands.claimNext(input);
    if (command === null) {
      return null;
    }
    const { kind } = command.payload;
    yield* Effect.annotateCurrentSpan({
      commandId: command.id,
      kind,
      taskId: command.taskId,
    });

    const reason = yield* refusalOf(command);
    if (reason === null) {
      yield* recordOutcome({ kind, result: "acted" });
      return {
        command,
        reason: null,
        result: "acted",
      } satisfies CommandOutcome;
    }

    const rejected = yield* commands.reject({
      id: command.id,
      reason,
      workspaceId: input.workspaceId,
    });
    yield* recordOutcome({ kind, result: "rejected" });
    yield* Effect.logWarning(`${kind} refused: ${reason}`);
    return {
      command: rejected,
      reason,
      result: "rejected",
    } satisfies CommandOutcome;
  });

  /**
   * Drains the queue, bounded. The bound is what keeps a burst of commands from
   * spending a whole pass: whatever is left waits for the next one, in the order
   * it was written.
   */
  const drain = Effect.fn("RunCommands.drain")(function* (input: DrainInput) {
    const limit = input.maxPerPass ?? DEFAULT_MAX_PER_PASS;
    const handled: CommandOutcome[] = [];
    for (let taken = 0; taken < limit; taken += 1) {
      const outcome = yield* consumeNext({ workspaceId: input.workspaceId });
      if (outcome === null) {
        break;
      }
      handled.push(outcome);
    }
    return handled as readonly CommandOutcome[];
  });

  return { consumeNext, drain } as const;
});

/**
 * The consumer of the run-command queue. One instance, because the repository
 * hands each command to exactly one claimant and this is the only thing that
 * claims.
 */
export class RunCommands extends Context.Service<
  RunCommands,
  Effect.Success<typeof makeRunCommands>
>()("@workspace/orchestrator/RunCommands") {
  static readonly layer = Layer.effect(RunCommands, makeRunCommands);
}
