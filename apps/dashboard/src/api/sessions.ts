import { queryOptions, useQuery } from "@tanstack/react-query";
import type { AgentSessionId, TaskId } from "@workspace/domain";
import type { Effect } from "effect";
import { keys } from "@/api/keys";
import { apiQuery } from "@/api/query";
import type { ApiClientShape } from "@/api/runtime";

type SessionClient = ApiClientShape["sessions"];

/** Everything the transcript read can fail with, taken from the call itself. */
type TranscriptFailure = Effect.Error<ReturnType<SessionClient["transcript"]>>;

/** The status the gateway answers with while an operation has no implementation. */
const NOT_IMPLEMENTED = 501;

/**
 * A task's agent conversations, newest first.
 *
 * Failed sessions are in the list on purpose: a session that crashed is part of
 * what happened on the task, and hiding it would leave a gap between two runs
 * that a reader cannot account for.
 */
export const sessionsQuery = (taskId: TaskId) =>
  apiQuery(keys.sessions(taskId), (client) =>
    client.sessions.list({ params: { taskId } })
  );

/**
 * What each of a task's sessions spent, keyed by session id.
 *
 * One request for the whole panel: the figure a reader wants at a glance —
 * how full is this context window — belongs on every row, and a per-row query
 * would turn a five-session task into five calls to draw five bars.
 *
 * A session with nothing recorded is absent from the answer rather than present
 * and zeroed, so the map lookup returning nothing is the honest empty state.
 */
export const sessionsUsageQuery = (taskId: TaskId) =>
  apiQuery(keys.sessionsUsage(taskId), (client) =>
    client.sessions.usage({ params: { taskId } })
  );

/** One session: its provider, its status, and why it failed if it did. */
export const sessionQuery = (taskId: TaskId, sessionId: AgentSessionId) =>
  apiQuery(keys.session(taskId, sessionId), (client) =>
    client.sessions.get({ params: { sessionId, taskId } })
  );

/**
 * Whether a failure is the server saying the operation does not exist yet.
 *
 * A 501 is not a fault the reader can do anything about and not a fault the
 * client should hide behind a retry — it is a fact about the deployment, and the
 * screen says so plainly.
 */
export const isNotImplemented = (error: TranscriptFailure | null) =>
  error !== null &&
  error._tag === "HttpClientError" &&
  error.response?.status === NOT_IMPLEMENTED;

/**
 * What the model was told and what it said back.
 *
 * Retries are off rather than merely limited: the endpoint has no
 * implementation behind it today, so every attempt costs a round trip to learn
 * the same thing. It stays in the data layer because the wiring is right and
 * only the server side is missing.
 */
export const transcriptQuery = (taskId: TaskId, sessionId: AgentSessionId) =>
  queryOptions({
    ...apiQuery([...keys.session(taskId, sessionId), "transcript"], (client) =>
      client.sessions.transcript({ params: { sessionId, taskId } })
    ),
    retry: false,
  });

/**
 * The transcript, with an honest answer when there is none to read.
 *
 * `unavailable` separates "this deployment cannot answer" from an ordinary
 * failure, so the panel can render an empty state that explains itself instead
 * of an error the operator would try to retry.
 */
export const useTranscript = (taskId: TaskId, sessionId: AgentSessionId) => {
  const query = useQuery(transcriptQuery(taskId, sessionId));
  return { query, unavailable: isNotImplemented(query.error) };
};
