/**
 * Agent sessions, and the transcripts behind them.
 *
 * Read only, because a session is opened and ended by the orchestrator around a
 * run. What a caller chooses is which session runs next, and that is a property
 * of the task.
 *
 * The list is unfiltered on purpose. A task accumulates sessions over its life
 * and some of them failed — a research session that produced nothing, a run
 * whose container died — and a failed session missing from the list would read
 * as a session that never happened. It stays, with its status and the message
 * saying why, so the switcher shows the history rather than the survivors.
 *
 * The transcript is the one operation here that is not implemented, and it
 * cannot be from this process as it is built: the file each provider writes is
 * parsed by `@workspace/harness`, which `apps/gateway` does not depend on, and
 * a second parser here would be a second answer to "what did the model say". It
 * answers 501 until that dependency is declared or the reading moves.
 *
 * What a session spent is served, and from the store rather than from the file,
 * for that same reason turned around: the orchestrator has already read the
 * transcript and stored the summary, so this process needs no parser and no
 * vendor SDK to answer — and the answer survives the transcript being cleaned
 * up, which a read-on-demand one would not.
 */

import { Api, NotFound, Principal } from "@workspace/api";
import {
  AgentSessionRepo,
  AgentSessionUsageRepo,
  type MalformedRow,
  type PersistenceError,
  NotFound as StoreNotFound,
  TaskRepo,
} from "@workspace/db";
import type { AgentSessionId, TaskId, WorkspaceId } from "@workspace/domain";
import { Effect } from "effect";
import { HttpApiBuilder } from "effect/unstable/httpapi";
import { atBuild } from "./at-build";
import { pending } from "./pending";

/** What a read of the store can fail with. */
type StoreFailure = MalformedRow | PersistenceError | StoreNotFound;

/**
 * Turns a store failure into the one this API declares.
 *
 * `Db.NotFound` is the only one the caller had a hand in. A row that no longer
 * decodes, or a driver that fell over, is a defect: dying on it puts it in the
 * ledger as a 500 rather than in the contract as an outcome an agent might
 * branch on.
 */
const wire = <A, R>(effect: Effect.Effect<A, StoreFailure, R>) =>
  Effect.catch(effect, (failure) =>
    failure instanceof StoreNotFound
      ? Effect.fail(new NotFound({ entity: failure.entity, id: failure.id }))
      : Effect.die(failure)
  );

/** What names a session in a request: the route's task as well as the session. */
interface SessionRoute {
  readonly sessionId: AgentSessionId;
  readonly taskId: TaskId;
  readonly workspaceId: WorkspaceId;
}

/**
 * The task the route names, or 404.
 *
 * Listing what hangs off a task that does not exist would answer an empty array
 * and let a caller believe the task is real and idle.
 */
const requireTask = (input: {
  readonly taskId: TaskId;
  readonly workspaceId: WorkspaceId;
}) =>
  Effect.gen(function* () {
    const tasks = yield* TaskRepo;
    return yield* wire(
      tasks.byId({ id: input.taskId, workspaceId: input.workspaceId })
    );
  });

/**
 * The session, checked against the task in the path.
 *
 * The store scopes a session lookup to the workspace and no further, so a
 * session id belonging to a neighbouring task would otherwise be readable
 * through any task's route — and the whole reason this surface nests under
 * `/tasks/:taskId` is that a run's token is checked against that one segment. A
 * session under another task is not this task's session, so it is absent rather
 * than forbidden.
 */
const requireSession = (route: SessionRoute) =>
  Effect.gen(function* () {
    const sessions = yield* AgentSessionRepo;
    const session = yield* wire(
      sessions.byId({ id: route.sessionId, workspaceId: route.workspaceId })
    );
    if (session.taskId !== route.taskId) {
      return yield* new NotFound({
        entity: "agent_session",
        id: route.sessionId,
      });
    }
    return session;
  });

/** The `sessions` group, implemented. */
export const sessionsHandlers = HttpApiBuilder.group(
  Api,
  "sessions",
  (handlers) =>
    Effect.gen(function* () {
      const on = yield* atBuild<
        AgentSessionRepo | AgentSessionUsageRepo | TaskRepo
      >();

      return handlers
        .handle("list", ({ params }) =>
          on(
            Effect.gen(function* () {
              const { workspaceId } = yield* Principal;
              yield* requireTask({ taskId: params.taskId, workspaceId });
              const sessions = yield* AgentSessionRepo;
              return yield* wire(
                sessions.listByTask({ taskId: params.taskId, workspaceId })
              );
            })
          )
        )
        .handle("get", ({ params }) =>
          on(
            Effect.gen(function* () {
              const { workspaceId } = yield* Principal;
              return yield* requireSession({ ...params, workspaceId });
            })
          )
        )
        .handle("transcript", pending("sessions.transcript"))
        .handle("usage", ({ params }) =>
          on(
            Effect.gen(function* () {
              const { workspaceId } = yield* Principal;
              yield* requireTask({ taskId: params.taskId, workspaceId });
              const usage = yield* AgentSessionUsageRepo;
              return yield* wire(
                usage.listByTask({ taskId: params.taskId, workspaceId })
              );
            })
          )
        );
    })
);
