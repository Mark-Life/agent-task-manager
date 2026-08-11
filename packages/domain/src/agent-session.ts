import { Schema } from "effect";
import type { RunOutcome } from "./enums";
import { SessionProvider, SessionStatus } from "./enums";
import { AgentSessionId, TaskId, ThreadId, UnreadWatermarkId } from "./ids";
import { recordFields, Timestamp } from "./primitives";

/**
 * One agent conversation, on a task or on a chat thread. A task has many of
 * these over its life — an implementation session, a review session that never
 * saw the code being written, the implementation session resuming with that
 * review as its prompt — so the link is a row rather than a column on the task.
 * A chat thread has them for the same reason: a session that cannot be resumed
 * is replaced by a new one and the conversation is kept.
 *
 * Named `agent_session` throughout because Better Auth owns `session` for a
 * browser login; the unqualified word in this codebase means theirs.
 */
export const AgentSession = Schema.Struct({
  ...recordFields,
  /** When the last run on this session terminated. Whether it can be resumed is {@link isResumable}, not this. */
  endedAt: Schema.NullOr(Timestamp),
  /** Why a failed session failed, so the list answers it without opening the run. */
  errorMessage: Schema.NullOr(Schema.String),
  id: AgentSessionId,
  provider: SessionProvider,
  /** Unknown until the harness reports it; kept apart from `provider` so the provider can change mid-task. */
  providerSessionId: Schema.NullOr(Schema.String),
  status: SessionStatus,
  /** Set on a session attached to a task, null on one attached to a thread. */
  taskId: Schema.NullOr(TaskId),
  /** Set on a session attached to a thread, null on one attached to a task. */
  threadId: Schema.NullOr(ThreadId),
  /**
   * The last row this session has been shown, compared as a `(createdAt, id)`
   * tuple so a same-millisecond tie cannot skip one. It is a task message on a
   * session attached to a task and a `chat_message` on one attached to a
   * thread — the same question either way, which is why it is one pair of
   * columns.
   *
   * Advanced at prompt-build time, including past this session's own previous
   * output — otherwise a resumed run reads what it said last time as new input.
   * Null means the session has been shown nothing, so its next prompt is the
   * conversation from the beginning.
   */
  unreadWatermarkAt: Schema.NullOr(Timestamp),
  unreadWatermarkId: Schema.NullOr(UnreadWatermarkId),
});

export interface AgentSession extends Schema.Schema.Type<typeof AgentSession> {}

/**
 * The run outcomes after which continuing the conversation is the right next
 * move. Chosen against the whole of `RUN_OUTCOMES`, and the four it leaves out
 * are the point.
 *
 * `done` is the ordinary one: the run finished and the session is `finished`.
 * `timeout` is the one this list exists for. The wall clock kills the container,
 * not the agent — the provider still holds the whole conversation, complete up
 * to the last turn it answered, and the work in it is exactly what the next
 * attempt would otherwise re-derive from nothing.
 *
 * `errored`, `lost` and `interrupted` are excluded because they say the run's
 * own state went wrong: a crash mid-turn, a process that stopped reporting, and
 * the loop going down under a run all leave a conversation that may be truncated
 * in the middle of a tool call, and resuming into it replays the thing that
 * broke.
 *
 * `stopped` is excluded on the same grounds and reaches a narrower set of
 * sessions than that reads like. This list is only ever consulted for a session
 * already marked `failed`, and a stop does not mark one: the terminal path fails
 * a session only for an ending that is not an interrupt, so a run somebody
 * stopped — and one the loop was carrying when it went down — finishes its
 * session instead, and a finished session is resumable whatever its last run
 * did. Stop then Rerun therefore continues the conversation, which is what the
 * Stop button is for. `stopped` is named here for the day that changes, not to
 * describe what happens today.
 */
export const RESUMABLE_OUTCOMES = ["done", "timeout"] as const;

/** {@link RESUMABLE_OUTCOMES} as a membership test, widened so a `RunOutcome` can be asked. */
const leavesConversationIntact = (outcome: RunOutcome) =>
  (RESUMABLE_OUTCOMES as readonly RunOutcome[]).includes(outcome);

/**
 * A session and how the runs on it ended — everything the resume decision reads.
 *
 * The outcomes are a separate field rather than something the session carries
 * because the session does not carry them: `AgentSession` has an `errorMessage`
 * and no failure cause, and the cause is a property of the run that ended it.
 */
export interface ResumeCandidate {
  /**
   * The outcomes of this session's runs, newest first. A live run has no
   * outcome yet and is not among them, so an empty list means the session has
   * never had a run reach a terminus.
   */
  readonly outcomes: readonly RunOutcome[];
  readonly session: Pick<AgentSession, "status">;
}

/**
 * Whether this session can be picked up again.
 *
 * A cleanly finished session is the normal resume target — "continue the task's
 * latest session" means exactly that — so a set `endedAt` disqualifies nothing,
 * and a session still running is being picked up by definition.
 *
 * A failed one is the question this function exists for. `failed` is written for
 * every ending that is not a clean finish, which flattens the agent breaking and
 * the clock running out into one status; the difference between them is the last
 * run's outcome, and {@link RESUMABLE_OUTCOMES} is which of those are worth
 * continuing.
 *
 * The repeat guard is the other half, and it is what keeps this from being a
 * more expensive bug than the one it fixes. Resuming a session that hit the wall
 * clock hands the next attempt the context that hit it — so it is offered once.
 * If the outcome that ended the newest run has already ended an earlier run on
 * the same session, resuming did not get past that wall and the next attempt
 * starts clean rather than walking into it a third time.
 */
export const isResumable = ({ outcomes, session }: ResumeCandidate) => {
  if (session.status !== "failed") {
    return true;
  }
  const [last, ...earlier] = outcomes;
  return (
    last !== undefined &&
    leavesConversationIntact(last) &&
    !earlier.includes(last)
  );
};
