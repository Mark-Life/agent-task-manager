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
import {
  AgentSession,
  AgentSessionUsage,
  Transcript,
} from "../schemas/session";
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

/**
 * What each of a task's sessions spent: tokens by kind, how much of the model's
 * context window the conversation is occupying, the curve it took to get there,
 * which tools did the work, and an estimated cost.
 *
 * One request for the whole panel rather than one per session, because the
 * figure a reader wants at a glance — how full is this window — belongs on
 * every row of the list, and a per-row request would put the board's session
 * list back to N calls to draw N bars.
 *
 * A session with no summary is absent from the array rather than present and
 * zeroed. Nothing has been computed for it: either no run has finished on it
 * yet, or the run that did died before the provider answered once. Both are
 * "nothing recorded", which is not "spent nothing".
 *
 * These figures are recomputed and stored at the end of each run, so a session
 * with a run in flight answers with what its last completed run left, and
 * `computedAt` is what says so.
 */
const usage = HttpApiEndpoint.get("usage", "/tasks/:taskId/sessions/usage", {
  error: NotFound,
  params: { taskId: TaskId },
  success: Schema.Array(AgentSessionUsage),
})
  .middleware(ReadAccess)
  .annotate(OpenApi.Summary, "Read what a task's sessions spent");

/** Sessions, the transcripts behind them, and what they spent. */
export class SessionsGroup extends HttpApiGroup.make("sessions")
  .add(list, get, transcript, usage)
  .annotate(
    OpenApi.Description,
    "Agent sessions: one conversation each, and the transcript it left."
  ) {}
