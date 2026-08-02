/**
 * Runs and their event streams.
 *
 * A run's timeline is served two ways over one table, and the pair is meant to
 * be used together: page back through what already happened, note the cursor
 * the last page returned, then open the stream from there. Nothing is missed in
 * the gap, because both are ordered by the same `seq` the container wrote.
 *
 * The stream is Server-Sent Events over the database's own notify channel, so a
 * dashboard watching a run costs one connection and no polling.
 */

import { RunId, TaskId } from "@workspace/domain";
import { Schema } from "effect";
import {
  HttpApiEndpoint,
  HttpApiGroup,
  HttpApiSchema,
  OpenApi,
} from "effect/unstable/httpapi";
import { NotFound } from "../errors";
import { Run, RunEvent, RunEventCursor, RunEventPage } from "../schemas/run";
import { ReadAccess } from "../security";

/** The largest page the store will assemble in one query. */
const MAX_EVENT_PAGE = 1000;

/** A task's attempts, newest first. */
const list = HttpApiEndpoint.get("list", "/tasks/:taskId/runs", {
  error: NotFound,
  params: { taskId: TaskId },
  success: Schema.Array(Run),
})
  .middleware(ReadAccess)
  .annotate(OpenApi.Summary, "List a task's runs");

/** One attempt: what it ran, what it cost, and how it ended. */
const get = HttpApiEndpoint.get("get", "/tasks/:taskId/runs/:runId", {
  error: NotFound,
  params: { runId: RunId, taskId: TaskId },
  success: Run,
})
  .middleware(ReadAccess)
  .annotate(OpenApi.Summary, "Get a run");

/** A page of the run's timeline, oldest first, from a cursor. */
const events = HttpApiEndpoint.get(
  "events",
  "/tasks/:taskId/runs/:runId/events",
  {
    error: NotFound,
    params: { runId: RunId, taskId: TaskId },
    query: {
      ...RunEventCursor,
      limit: Schema.optionalKey(
        Schema.Int.pipe(
          Schema.check(
            Schema.isBetween({ maximum: MAX_EVENT_PAGE, minimum: 1 })
          )
        )
      ),
    },
    success: RunEventPage,
  }
)
  .middleware(ReadAccess)
  .annotate(OpenApi.Summary, "Read a page of a run's events");

/**
 * The rest of the timeline, as it happens.
 *
 * `afterSeq` is what makes reconnecting cheap and correct: the client replays
 * from where it stopped rather than from the beginning or from now. A finished
 * run's stream closes once it has caught up, so a subscriber never waits on a
 * run that already ended.
 *
 * A generic OpenAPI consumer sees `text/event-stream` and the event schema, and
 * nothing in the document tells it to hold the connection open — streaming to an
 * external agent is a deliberate integration, not a free consequence of the
 * spec.
 */
const stream = HttpApiEndpoint.get(
  "stream",
  "/tasks/:taskId/runs/:runId/events/stream",
  {
    error: NotFound,
    params: { runId: RunId, taskId: TaskId },
    query: RunEventCursor,
    success: HttpApiSchema.StreamSse({ data: RunEvent }),
  }
)
  .middleware(ReadAccess)
  .annotate(OpenApi.Summary, "Stream a run's events as they happen");

/** Runs, and the one table their timeline lives in. */
export class RunsGroup extends HttpApiGroup.make("runs")
  .add(list, get, events, stream)
  .annotate(
    OpenApi.Description,
    "Runs: one attempt each, and the events they emit."
  ) {}
