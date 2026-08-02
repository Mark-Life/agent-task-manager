/**
 * Run commands: intents the orchestrator acts on.
 *
 * Nothing here touches a container, and that is the whole design. The
 * orchestrator owns container lifecycle; a person, the manager agent and a
 * worker agent all steer by writing a row, so every intervention is attributed
 * to whoever asked for it and there is no second door into starting or stopping
 * work.
 *
 * So a handler writes the intent and answers with it. It does not decide
 * whether the intent will be honoured: an intent the orchestrator will refuse
 * is still written, claimed, and rejected there with a reason on the row —
 * "there is no live run on this task to stop" is an answer somebody asked for,
 * and pre-empting it here would replace a recorded refusal with a 4xx nobody
 * can read afterwards. The only things refused up front are the two the
 * contract declares: a task that does not exist, and a payload the store will
 * not encode.
 *
 * Stop and rerun are both available on a live run, because they are the two
 * halves of interrupting one. Stop kills the process; rerun resumes the same
 * session with everything said since as its next prompt, which is how a comment
 * becomes an instruction. Neither needs the run to be in any particular state
 * for the row to be worth writing.
 *
 * A run named in the body is checked against the task in the path. The
 * orchestrator resolves a named run by id within the workspace and no further,
 * so without that check a token bound to one task could queue a stop against a
 * run belonging to another — which is exactly what nesting this surface under
 * `/tasks/:taskId` exists to prevent.
 */

import { Api, InvalidInput, NotFound, Principal } from "@workspace/api";
import {
  type MalformedRow,
  type PersistenceError,
  RunCommandRepo,
  RunRepo,
  InvalidInput as StoreInvalidInput,
  NotFound as StoreNotFound,
  TaskRepo,
  withActor,
} from "@workspace/db";
import type {
  Actor,
  RunCommandPayload,
  RunId,
  TaskId,
  WorkspaceId,
} from "@workspace/domain";
import { Effect } from "effect";
import { HttpApiBuilder } from "effect/unstable/httpapi";
import { atBuild } from "./at-build";

/** How much of a refusal is repeated back. Long enough to name the field, short enough to bound the body. */
const DETAIL_LIMIT = 240;

/** What reading or writing through the store can fail with. */
type StoreFailure =
  | MalformedRow
  | PersistenceError
  | StoreInvalidInput
  | StoreNotFound;

/**
 * Turns a store failure into the one this API declares.
 *
 * `Db.NotFound` is the only one the caller had a hand in here. A row that no
 * longer decodes, a driver that fell over, or a payload this handler built
 * wrong is a defect: dying on it puts it in the ledger as a 500 rather than in
 * the contract as an outcome an agent might branch on.
 */
const asNotFound = (failure: StoreFailure) =>
  failure instanceof StoreNotFound
    ? Effect.fail(new NotFound({ entity: failure.entity, id: failure.id }))
    : Effect.die(failure);

/**
 * The same, for the one operation whose body carries a value the store can
 * refuse. The refusal is repeated back clipped, because it is a schema message
 * and the caller only needs to know which field it was.
 */
const asRefusal = (
  failure: StoreFailure
): Effect.Effect<never, InvalidInput | NotFound> =>
  failure instanceof StoreInvalidInput
    ? Effect.fail(
        new InvalidInput({
          detail: String(failure.cause).slice(0, DETAIL_LIMIT),
          entity: failure.entity,
        })
      )
    : asNotFound(failure);

/** What every intent on this surface names. */
interface CommandRoute {
  readonly actor: Actor;
  readonly taskId: TaskId;
  readonly workspaceId: WorkspaceId;
}

/**
 * The task the route names, or 404. A command row carries a foreign key to the
 * task, so writing one for a task that does not exist would come back as a
 * constraint violation — a 500 for something the caller can read and fix.
 */
const requireTask = (input: {
  readonly taskId: TaskId;
  readonly workspaceId: WorkspaceId;
}) =>
  Effect.gen(function* () {
    const tasks = yield* TaskRepo;
    return yield* Effect.catch(
      tasks.byId({ id: input.taskId, workspaceId: input.workspaceId }),
      asNotFound
    );
  });

/** Refuses a run that is not this task's, so a named target cannot cross a task boundary. */
const requireRun = (input: {
  readonly runId: RunId;
  readonly taskId: TaskId;
  readonly workspaceId: WorkspaceId;
}) =>
  Effect.gen(function* () {
    const runs = yield* RunRepo;
    const run = yield* Effect.catch(
      runs.byId({ id: input.runId, workspaceId: input.workspaceId }),
      asNotFound
    );
    if (run.taskId !== input.taskId) {
      return yield* Effect.fail(
        new NotFound({ entity: "run", id: input.runId })
      );
    }
    return run;
  });

/**
 * Writes one intent as the caller.
 *
 * The actor comes from the credential and is provided for the write alone, so
 * the row names the person or agent who asked rather than the process that
 * relayed it. A second identical intent while the first is still pending
 * returns the one already queued — the repository's doing, and what keeps a
 * double-clicked Stop from landing a row that could only be rejected as noise.
 */
const enqueue = (
  route: CommandRoute,
  input: {
    readonly payload: RunCommandPayload;
    readonly runId?: RunId;
  }
) =>
  Effect.gen(function* () {
    const commands = yield* RunCommandRepo;
    return yield* withActor(route.actor)(
      commands.enqueue({
        payload: input.payload,
        runId: input.runId,
        taskId: route.taskId,
        workspaceId: route.workspaceId,
      })
    );
  });

/**
 * What stop and rerun share: prove the task, prove the named run if there is
 * one, then write. Absent, the run is whichever one is live when the
 * orchestrator reads the row — which is what a Stop button means and why it is
 * not resolved here.
 */
const target = (
  route: CommandRoute,
  input: {
    readonly payload: RunCommandPayload;
    readonly runId?: RunId;
  }
) =>
  Effect.gen(function* () {
    yield* requireTask(route);
    if (input.runId !== undefined) {
      yield* requireRun({ ...route, runId: input.runId });
    }
    return yield* Effect.catch(enqueue(route, input), asNotFound);
  });

/** The `runCommands` group, implemented. */
export const runCommandsHandlers = HttpApiBuilder.group(
  Api,
  "runCommands",
  (handlers) =>
    Effect.gen(function* () {
      const on = yield* atBuild<RunCommandRepo | RunRepo | TaskRepo>();

      return handlers
        .handle("list", ({ params }) =>
          on(
            Effect.gen(function* () {
              const { workspaceId } = yield* Principal;
              yield* requireTask({ taskId: params.taskId, workspaceId });
              const commands = yield* RunCommandRepo;
              return yield* Effect.catch(
                commands.listByTask({ taskId: params.taskId, workspaceId }),
                asNotFound
              );
            })
          )
        )
        .handle("stop", ({ params, payload }) =>
          on(
            Effect.gen(function* () {
              const { actor, workspaceId } = yield* Principal;
              return yield* target(
                { actor, taskId: params.taskId, workspaceId },
                { payload: { kind: "stop" }, runId: payload.runId }
              );
            })
          )
        )
        .handle("rerun", ({ params, payload }) =>
          on(
            Effect.gen(function* () {
              const { actor, workspaceId } = yield* Principal;
              return yield* target(
                { actor, taskId: params.taskId, workspaceId },
                { payload: { kind: "rerun" }, runId: payload.runId }
              );
            })
          )
        )
        .handle("startSession", ({ params, payload }) =>
          on(
            Effect.gen(function* () {
              const { actor, workspaceId } = yield* Principal;
              const route = { actor, taskId: params.taskId, workspaceId };
              yield* requireTask(route);
              return yield* Effect.catch(
                enqueue(route, {
                  payload: { kind: "start_session", trigger: payload.trigger },
                }),
                asRefusal
              );
            })
          )
        );
    })
);
