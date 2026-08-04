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
  RunSubject,
  RunTrigger,
  Task,
  WorkspaceId,
} from "@workspace/domain";
import { isRunLive, RUN_COMMAND_KINDS } from "@workspace/domain";
import { boundedCounter } from "@workspace/telemetry";
import { Cause, Context, DateTime, Effect, Layer } from "effect";
import { describeFailure } from "./errors";
import { subjectKeyOf, subjectOfRow } from "./subject";

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
  readonly subject: RunSubject;
  /**
   * The W3C `traceparent` the command row carried, so the run this starts
   * belongs to the request that asked for it rather than to the poll that
   * happened to pick the row up. Null for a command written outside a trace.
   */
  readonly traceparent: string | null;
  readonly trigger: RunTrigger;
  readonly workspaceId: WorkspaceId;
}

/** What killing a container needs. */
export interface StopRequest {
  readonly runId: RunId;
  /** Which piece of work the fiber to interrupt is keyed by. */
  readonly subject: RunSubject;
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
    readonly subject: RunSubject;
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
        subject: input.subject,
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

  /** The live run on whichever piece of work a command names. */
  const liveFor = (input: {
    readonly subject: RunSubject;
    readonly workspaceId: WorkspaceId;
  }) =>
    input.subject.kind === "task"
      ? runs.liveForTask({
          taskId: input.subject.id,
          workspaceId: input.workspaceId,
        })
      : runs.liveForThread({
          threadId: input.subject.id,
          workspaceId: input.workspaceId,
        });

  /** The run a stop names, or the live one on its subject when it names none. */
  const stopTarget = (command: RunCommand, subject: RunSubject) =>
    command.runId === null
      ? liveFor({ subject, workspaceId: command.workspaceId })
      : runs.byId({ id: command.runId, workspaceId: command.workspaceId });

  /**
   * Stops a live run, whatever it is attached to.
   *
   * This is also chat's force send: the button files a stop naming the thread,
   * the turn closes as `interrupted`, and the messages that arrived after it
   * built its prompt are still unread — so the next dispatch resumes the same
   * conversation with them appended, with no machinery of its own.
   */
  const handleStop = Effect.fn("RunCommands.stop")(function* (
    command: RunCommand,
    subject: RunSubject
  ) {
    const target = yield* stopTarget(command, subject);
    if (target === null) {
      return `there is no live run on this ${subject.kind} to stop`;
    }
    if (!isRunLive(target)) {
      return `run ${target.id} is already ${target.status}`;
    }

    const killed = yield* control.stop({
      runId: target.id,
      // The run's own columns, falling back to what the command named: a stop
      // by run id can target a run on a different subject than the caller
      // believed, and the fiber to interrupt is keyed by the run's.
      subject: subjectOfRow(target) ?? subject,
      workspaceId: command.workspaceId,
    });
    if (!killed) {
      yield* Effect.logWarning(
        `stop found no live container for run ${target.id} — closing the row anyway`
      );
    }

    yield* appendStopped({ command, runId: target.id, subject });
    yield* closeInterrupted({
      runId: target.id,
      workspaceId: command.workspaceId,
    });
    return null;
  });

  /**
   * The task a command is about, or a refusal naming why there is none.
   *
   * Rerunning and spawning a session are moves on a board card. A conversation
   * has none: the way to make a manager answer again is to say something else
   * in it, which is a message rather than a command.
   */
  const taskOf = Effect.fnUntraced(function* (input: {
    readonly kind: RunCommandKind;
    readonly subject: RunSubject;
    readonly workspaceId: WorkspaceId;
  }) {
    if (input.subject.kind !== "task") {
      return { refusal: `a ${input.kind} names a task, not a thread` } as const;
    }
    return {
      task: yield* tasks.byId({
        id: input.subject.id,
        workspaceId: input.workspaceId,
      }),
    } as const;
  });

  /**
   * Resumes the task's session with everything said since as its next prompt —
   * which is the prompt builder's job, off the session's watermark, so all this
   * has to do is start the run.
   *
   * The status check is the reason this is not a back door into the board: a
   * rerun on a task that is not in progress would put a container on a card
   * nobody moved.
   */
  const handleRerun = Effect.fn("RunCommands.rerun")(function* (
    command: RunCommand,
    subject: RunSubject
  ) {
    const found = yield* taskOf({
      kind: "rerun",
      subject,
      workspaceId: command.workspaceId,
    });
    if (found.refusal !== undefined) {
      return found.refusal;
    }
    if (found.task.status !== "in_progress") {
      return `a rerun needs the task in progress, and it is in ${found.task.status}`;
    }
    const live = yield* liveFor({ subject, workspaceId: command.workspaceId });
    if (live !== null) {
      return `run ${live.id} is already live on this task — stop it first`;
    }
    yield* unpark(found.task);
    yield* control.dispatch({
      subject,
      traceparent: command.traceparent,
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
    subject: RunSubject,
    trigger: RunTrigger
  ) {
    if (!SPAWNABLE_TRIGGERS.includes(trigger)) {
      return `a start_session cannot claim the ${trigger} trigger`;
    }
    const found = yield* taskOf({
      kind: "start_session",
      subject,
      workspaceId: command.workspaceId,
    });
    if (found.refusal !== undefined) {
      return found.refusal;
    }
    const live = yield* liveFor({ subject, workspaceId: command.workspaceId });
    if (live !== null) {
      return `run ${live.id} is already live on this task — stop it first`;
    }
    yield* unpark(found.task);
    yield* control.dispatch({
      subject,
      traceparent: command.traceparent,
      trigger,
      workspaceId: command.workspaceId,
    });
    return null;
  });

  /** The refusal, or null where the command was acted on. */
  const handle = (command: RunCommand, subject: RunSubject) => {
    switch (command.payload.kind) {
      case "stop":
        return handleStop(command, subject);
      case "rerun":
        return handleRerun(command, subject);
      default:
        return handleStartSession(command, subject, command.payload.trigger);
    }
  };

  /**
   * Runs the handler and turns anything at all into a refusal. Defects included:
   * the command row is already consumed by the time a handler runs, so a thrown
   * value that escaped would leave an intent with no outcome on it — which is
   * exactly the silence this module exists to avoid.
   */
  const refusalOf = (command: RunCommand, subject: RunSubject) =>
    handle(command, subject).pipe(
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
    const subject = subjectOfRow(command);
    yield* Effect.annotateCurrentSpan({
      commandId: command.id,
      kind,
      subjectKey: subject === null ? null : subjectKeyOf(subject),
    });

    // A command whose two id columns disagree with its role cannot exist —
    // the check constraint refuses it — so this is a row the database no
    // longer describes, and refusing it says so rather than guessing.
    const reason =
      subject === null
        ? "this command names neither a task nor a thread"
        : yield* refusalOf(command, subject);
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
