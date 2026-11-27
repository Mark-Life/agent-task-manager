/**
 * What a task's runs did: runs, events, sessions, commands, artifacts and
 * proposals.
 */

import { Api, Forbidden, NotFound, type RunCommand } from "@workspace/api";
import {
  isRunLive,
  newRunCommandId,
  type RunCommandPayload,
  type RunId,
  type TaskId,
} from "@workspace/domain";
import { Effect, Stream } from "effect";
import { HttpApiBuilder } from "effect/unstable/httpapi";
import { RUNS } from "@/demo/fixtures/runs";
import { ARTIFACT_BODIES } from "@/demo/fixtures/workspace";
import { DEMO_USER, DEMO_WORKSPACE, now } from "@/demo/ids";
import { liveEvents } from "@/demo/live";
import { db, find, millis, update } from "@/demo/store";

const runOf = (taskId: TaskId, runId: RunId) =>
  Effect.filterOrFail(
    find(db.runs, "run", runId),
    (run) => run.taskId === taskId,
    () => new NotFound({ entity: "run", id: runId })
  );

/** Queue a command and, since there is no orchestrator, act on it at once. */
const command = (
  taskId: TaskId,
  payload: RunCommandPayload,
  runId: RunId | null
): RunCommand => {
  const at = now();
  const row: RunCommand = {
    actorKind: "human",
    actorRunId: null,
    actorSessionId: null,
    actorUserId: DEMO_USER,
    consumedAt: at,
    createdAt: at,
    id: newRunCommandId(),
    payload,
    rejectedReason: null,
    runId,
    status: "consumed",
    taskId,
    threadId: null,
    traceparent: null,
    updatedAt: at,
    workspaceId: DEMO_WORKSPACE,
  };
  db.commands.push(row);
  if (payload.kind === "stop") {
    for (const run of db.runs) {
      if (run.taskId === taskId && isRunLive(run)) {
        update(db.runs, {
          ...run,
          finishedAt: at,
          outcome: "stopped",
          status: "interrupted",
          updatedAt: at,
        });
      }
    }
  }
  return row;
};

const liveRunId = (taskId: TaskId) =>
  db.runs.find((run) => run.taskId === taskId && isRunLive(run))?.id ?? null;

export const runsHandlers = HttpApiBuilder.group(Api, "runs", (handlers) =>
  handlers
    .handle("list", ({ params }) =>
      Effect.sync(() =>
        db.runs
          .filter((run) => run.taskId === params.taskId)
          .sort((a, b) => millis(b.createdAt) - millis(a.createdAt))
      )
    )
    .handle("get", ({ params }) => runOf(params.taskId, params.runId))
    .handle("events", ({ params, query }) =>
      Effect.map(runOf(params.taskId, params.runId), (run) => ({
        events: db.events.filter(
          (event) => event.runId === run.id && event.seq > (query.afterSeq ?? 0)
        ),
        nextSeq: null,
      }))
    )
    .handle("stream", ({ params, query }) =>
      Effect.map(runOf(params.taskId, params.runId), (run) => {
        const past = Stream.fromIterable(
          db.events.filter(
            (event) =>
              event.runId === run.id && event.seq > (query.afterSeq ?? 0)
          )
        );
        // A live run stays open and keeps working, as a real one would.
        return isRunLive(run) ? Stream.concat(past, liveEvents(run)) : past;
      })
    )
);

export const sessionsHandlers = HttpApiBuilder.group(
  Api,
  "sessions",
  (handlers) =>
    handlers
      .handle("list", ({ params }) =>
        Effect.sync(() =>
          db.sessions.filter((session) => session.taskId === params.taskId)
        )
      )
      .handle("get", ({ params }) =>
        find(db.sessions, "session", params.sessionId)
      )
      .handle("transcript", ({ params }) => {
        const demo = RUNS.find((run) => run.session.id === params.sessionId);
        return demo === undefined
          ? Effect.succeed({ entries: [], providerSessionId: null, usage: [] })
          : Effect.succeed(demo.transcript);
      })
      .handle("usage", ({ params }) =>
        Effect.sync(() =>
          RUNS.filter((run) => run.session.taskId === params.taskId).map(
            (run) => run.usage
          )
        )
      )
);

export const runCommandsHandlers = HttpApiBuilder.group(
  Api,
  "runCommands",
  (handlers) =>
    handlers
      .handle("list", ({ params }) =>
        Effect.sync(() =>
          db.commands.filter((row) => row.taskId === params.taskId)
        )
      )
      .handle("stop", ({ params, payload }) =>
        Effect.sync(() =>
          command(
            params.taskId,
            { kind: "stop" },
            payload.runId ?? liveRunId(params.taskId)
          )
        )
      )
      .handle("rerun", ({ params, payload }) =>
        Effect.sync(() =>
          command(params.taskId, { kind: "rerun" }, payload.runId ?? null)
        )
      )
      .handle("startSession", ({ params, payload }) =>
        Effect.sync(() =>
          command(
            params.taskId,
            { kind: "start_session", trigger: payload.trigger },
            null
          )
        )
      )
);

const forbidden = () =>
  Effect.fail(
    new Forbidden({ reason: "Read-only in the demo.", required: "none" })
  );

export const artifactsHandlers = HttpApiBuilder.group(
  Api,
  "artifacts",
  (handlers) =>
    handlers
      .handle("list", ({ params }) =>
        Effect.sync(() =>
          db.artifacts.filter((artifact) => artifact.taskId === params.taskId)
        )
      )
      .handle("listProject", ({ params }) =>
        Effect.sync(() =>
          db.artifacts.filter(
            (artifact) =>
              artifact.projectId === params.projectId &&
              artifact.scope === "project"
          )
        )
      )
      .handle("read", ({ params }) =>
        Effect.map(find(db.artifacts, "artifact", params.artifactId), (row) =>
          Stream.make(
            new TextEncoder().encode(ARTIFACT_BODIES.get(row.id) ?? "")
          )
        )
      )
      .handle("upload", forbidden)
      .handle("promote", ({ params, payload }) =>
        Effect.map(find(db.artifacts, "artifact", params.artifactId), (row) =>
          update(db.artifacts, {
            ...row,
            promotedAt: now(),
            scope: payload.scope,
          })
        )
      )
);

export const proposalsHandlers = HttpApiBuilder.group(
  Api,
  "proposals",
  (handlers) =>
    handlers
      .handle("list", () => Effect.succeed([]))
      .handle("confirm", forbidden)
      .handle("reject", forbidden)
);
