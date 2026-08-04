/**
 * The agent conversations on a task.
 *
 * A task has many over its life — an implementation session, a review session
 * that never saw the code being written, the implementation session resuming
 * with that review as its prompt — so they are rows under the task rather than
 * a column on it.
 *
 * Read only. A session is opened and ended by the orchestrator, around a run;
 * what a caller chooses is which one runs next, and that is a property of the
 * task (`PUT /tasks/:taskId/next-session`).
 */

import { AgentSessionId, TaskId } from "@workspace/domain";
import { Schema } from "effect";
import {
  HttpApiEndpoint,
  HttpApiGroup,
  OpenApi,
} from "effect/unstable/httpapi";
import { NotFound } from "../errors";
import { AgentSession, Transcript } from "../schemas/session";
import { ReadAccess } from "../security";

/** A task's sessions, newest first — the order the switcher lists them in. */
const list = HttpApiEndpoint.get("list", "/tasks/:taskId/sessions", {
  error: NotFound,
  params: { taskId: TaskId },
  success: Schema.Array(AgentSession),
})
  .middleware(ReadAccess)
  .annotate(OpenApi.Summary, "List a task's agent sessions");

/** One session: its provider, its status, and why it failed if it did. */
const get = HttpApiEndpoint.get("get", "/tasks/:taskId/sessions/:sessionId", {
  error: NotFound,
  params: { sessionId: AgentSessionId, taskId: TaskId },
  success: AgentSession,
})
  .middleware(ReadAccess)
  .annotate(OpenApi.Summary, "Get an agent session");

/**
 * What the model was actually told and what it said back, read off the file the
 * provider wrote.
 *
 * Not from the database: there is no table of transcript messages and there is
 * not meant to be one — the run's events are the timeline, and duplicating every
 * assistant message into Postgres would give a reader two sources for one run.
 * A session whose file is gone reads as an empty transcript, because "nothing
 * recorded" is an answer and a 404 here would be a lie about the session.
 */
const transcript = HttpApiEndpoint.get(
  "transcript",
  "/tasks/:taskId/sessions/:sessionId/transcript",
  {
    error: NotFound,
    params: { sessionId: AgentSessionId, taskId: TaskId },
    success: Transcript,
  }
)
  .middleware(ReadAccess)
  .annotate(OpenApi.Summary, "Read a session's transcript");

/** Sessions, and the transcripts behind them. */
export class SessionsGroup extends HttpApiGroup.make("sessions")
  .add(list, get, transcript)
  .annotate(
    OpenApi.Description,
    "Agent sessions: one conversation each, and the transcript it left."
  ) {}
