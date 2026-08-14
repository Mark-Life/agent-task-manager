/**
 * Runs, their paged timeline and their live stream.
 *
 * One append-only table stands behind all three reads, and that is the point:
 * `run_event` is the live feed the dashboard watches, the replay a reader
 * scrolls back through, and the record of what an agent actually did. There is
 * no second timeline to reconcile against, so a page and a stream of the same
 * run cannot disagree — they differ only in whether they wait for more.
 *
 * The pair is meant to be used together. Page back from the start, keep the
 * cursor the last page returned, then open the stream from it: both are ordered
 * by the `seq` the container wrote, so nothing falls into the gap between them.
 *
 * The live tail itself is not here. Following a run means holding a listener on
 * the database's notify channel and draining from a cursor, which is a lifetime
 * to manage rather than a query to run — `../sse` owns it. What this file owns
 * is the same thing for every endpoint below: prove the run belongs to the task
 * in the path, then hand back what the store says.
 */

import { Api, DEFAULT_EVENT_PAGE, NotFound, Principal } from "@workspace/api";
import {
  type MalformedRow,
  type PersistenceError,
  RunEventRepo,
  RunRepo,
  NotFound as StoreNotFound,
  TaskRepo,
} from "@workspace/db";
import type { RunId, TaskId, WorkspaceId } from "@workspace/domain";
import { Effect } from "effect";
import { HttpApiBuilder } from "effect/unstable/httpapi";
import { type RunEventNotices, runEventStream } from "../sse";
import { atBuild } from "./at-build";

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

/** What names a run in a request: the route's task as well as the run. */
interface RunRoute {
  readonly runId: RunId;
  readonly taskId: TaskId;
  readonly workspaceId: WorkspaceId;
}

/**
 * The task the route names, or 404. Listing the runs of a task that does not
 * exist would answer an empty array and let a caller believe the task is real
 * and has never run.
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
 * The run, checked against the task in the path.
 *
 * The store scopes a run lookup to the workspace and no further, so a run id
 * belonging to a neighbouring task would otherwise be readable — and worse,
 * addressable — through any task's route, which is the one thing nesting this
 * surface under `/tasks/:taskId` exists to prevent. A run under another task is
 * not this task's run, so it is absent rather than forbidden.
 */
const requireRun = (route: RunRoute) =>
  Effect.gen(function* () {
    const runs = yield* RunRepo;
    const run = yield* wire(
      runs.byId({ id: route.runId, workspaceId: route.workspaceId })
    );
    if (run.taskId !== route.taskId) {
      return yield* new NotFound({ entity: "run", id: route.runId });
    }
    return run;
  });

/** The `runs` group, implemented. */
export const runsHandlers = HttpApiBuilder.group(Api, "runs", (handlers) =>
  Effect.gen(function* () {
    // The notice multicast is among them, and deliberately: one `LISTEN` for
    // the process, shared by every open stream, is what keeps a hundred
    // dashboard tabs from being a hundred connections.
    const on = yield* atBuild<
      RunEventNotices | RunEventRepo | RunRepo | TaskRepo
    >();

    return handlers
      .handle("list", ({ params }) =>
        on(
          Effect.gen(function* () {
            const { workspaceId } = yield* Principal;
            yield* requireTask({ taskId: params.taskId, workspaceId });
            const runs = yield* RunRepo;
            return yield* wire(
              runs.listByTask({ taskId: params.taskId, workspaceId })
            );
          })
        )
      )
      .handle("get", ({ params }) =>
        on(
          Effect.gen(function* () {
            const { workspaceId } = yield* Principal;
            return yield* requireRun({ ...params, workspaceId });
          })
        )
      )
      .handle("events", ({ params, query }) =>
        on(
          Effect.gen(function* () {
            const { workspaceId } = yield* Principal;
            yield* requireRun({ ...params, workspaceId });
            const events = yield* RunEventRepo;
            const limit = query.limit ?? DEFAULT_EVENT_PAGE;
            const page = yield* wire(
              events.listByRun({
                afterSeq: query.afterSeq,
                limit,
                runId: params.runId,
                workspaceId,
              })
            );
            const last = page.at(-1);
            // A short page has reached the end of what exists — which on a live
            // run is not the end of the run, and is where a reader switches to
            // the stream. A full one says only that there may be more.
            return {
              events: page,
              nextSeq:
                last === undefined || page.length < limit ? null : last.seq,
            };
          })
        )
      )
      .handle("stream", ({ params, query }) =>
        on(
          Effect.gen(function* () {
            const { workspaceId } = yield* Principal;
            // Before the subscription, not inside it: a 404 is a status code,
            // and once the stream is the response the status has been sent.
            yield* requireRun({ ...params, workspaceId });
            return yield* runEventStream({
              afterSeq: query.afterSeq,
              runId: params.runId,
              taskId: params.taskId,
              workspaceId,
            });
          })
        )
      );
  })
);
