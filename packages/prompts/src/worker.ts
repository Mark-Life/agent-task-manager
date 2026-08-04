/**
 * What a worker run is told, and — the part that matters — what it is not told
 * twice.
 *
 * A fresh session is situated from nothing: the task, the project it belongs
 * to, the checkout it was given, and the standing rules about where output
 * goes. A resumed session already holds every one of those in its own history,
 * so it is given exactly what has arrived since it last read the thread — every
 * comment past its watermark, each labelled with who wrote it. That single
 * mechanism covers the whole review loop with no special-casing: the
 * implementation session comes back and reads "the review session found X" and
 * "you said Y", and it works unchanged for two sessions or ten.
 *
 * A fresh session takes the same path with a null watermark, which reads as
 * "has seen nothing" and yields the thread from the beginning. That is
 * deliberate: a human who files a task, adds "also do X" as a comment, and
 * drags the card into *in progress* has said something the first run must hear,
 * and one code path is what guarantees it does.
 *
 * Everything here is pure — rows in, string out — so every shape is testable
 * without a database. Fetching the rows and moving the watermark is the
 * orchestrator's half.
 */

import type {
  AgentSessionId,
  Comment,
  CommentKind,
  Project,
  Task,
} from "@workspace/domain";
import {
  conversation,
  joinSections,
  type PromptMode,
  placementSection,
  promptOf,
  type RunPlacement,
  section,
  speech,
} from "./render";
import { ARTIFACT_RULES, SHARED_RULES, WORKER_RULES } from "./rules";

/**
 * How much of a session id goes in a label. Enough to tell two sessions on one
 * task apart and to find the row in the dashboard, short enough that the agent
 * reads it as a name rather than as an argument to pass somewhere.
 */
const SESSION_LABEL_CHARS = 8;

/**
 * What each kind of comment is, appended to its author's label. `message` says
 * nothing extra because it is the ordinary case; the other two are worth
 * flagging, since one is a machine's summary of a turn and the other is an
 * epitaph the orchestrator wrote for a run that died.
 */
const KIND_NOTE = {
  fallback: " (auto-appended final message)",
  message: "",
  run_error: " (that run crashed)",
} as const satisfies Record<CommentKind, string>;

/** A comment, and the session reading it — which is what "you" means. */
export interface CommentLabelInput {
  readonly comment: Comment;
  /** The session this run is, so its own earlier output reads as its own. */
  readonly readerSessionId: AgentSessionId;
}

/**
 * Who wrote a comment, in the words the reader needs.
 *
 * Attribution is the thing that makes several sessions on one task readable: an
 * agent that cannot tell "the human asked for X" from "another session claims
 * it did X" has one undifferentiated voice to reason about. The reader's own
 * earlier words are labelled as its own, and any other session carries a short
 * id so two of them do not blur into one.
 */
export const commentLabelOf = ({
  comment,
  readerSessionId,
}: CommentLabelInput) => {
  const note = KIND_NOTE[comment.kind];
  if (comment.authorKind === "human") {
    return `the human said${note}:`;
  }
  if (comment.authorKind === "manager") {
    return `the manager agent said${note}:`;
  }
  if (comment.authorKind === "orchestrator") {
    return `the orchestrator said${note}:`;
  }
  if (comment.agentSessionId === readerSessionId) {
    return `you said${note}:`;
  }
  const named =
    comment.agentSessionId === null
      ? "another session on this task"
      : `another session on this task (${comment.agentSessionId.slice(0, SESSION_LABEL_CHARS)})`;
  return `${named} said${note}:`;
};

/** One comment as the agent reads it: who said it, then what they said. */
export const renderComment = (input: CommentLabelInput) =>
  speech({ body: input.comment.body, label: commentLabelOf(input) });

/** The thread, oldest first, blank line between speakers. */
const renderThread = (
  comments: readonly Comment[],
  readerSessionId: AgentSessionId
) =>
  conversation(
    comments.map((comment) => renderComment({ comment, readerSessionId }))
  );

/** The project a task belongs to, as one line of context. */
const projectSection = (project: WorkerPromptInput["project"]) => {
  if (project === null) {
    return null;
  }
  return project.description === null
    ? project.name
    : `${project.name} — ${project.description}`;
};

/** What the assembly needs: the task, where it runs, and the comments it has not seen. */
export interface WorkerPromptInput {
  /**
   * Every comment after the session's watermark, oldest first. Empty is an
   * ordinary case — a rerun with nothing added — and reads as such.
   */
  readonly comments: readonly Comment[];
  readonly mode: PromptMode;
  readonly placement: RunPlacement;
  readonly project: Pick<Project, "description" | "name"> | null;
  /** The session this run is, so its own earlier output reads as its own. */
  readonly readerSessionId: AgentSessionId;
  readonly repoUrl: string | null;
  readonly task: Pick<Task, "acceptance" | "brief" | "title">;
}

/** The full situating prompt a session that has never run gets. */
const freshPrompt = (input: WorkerPromptInput) => {
  const { placement, project, repoUrl, task } = input;
  return joinSections([
    `# ${task.title}`,
    task.brief.trim(),
    section("Acceptance criteria", task.acceptance),
    section("Project", projectSection(project)),
    section("Where you are working", placementSection({ placement, repoUrl })),
    ARTIFACT_RULES,
    SHARED_RULES,
    section(
      "The conversation on this task so far",
      renderThread(input.comments, input.readerSessionId)
    ),
    section("Before you finish", WORKER_RULES),
  ]);
};

/**
 * What a session that has run before gets: the new comments and nothing else.
 *
 * Nothing else is the point. The task, its brief, the paths and the rules are
 * all in this session's own history, and restating them is how a resumed run
 * ends up re-reading its instructions as though they had changed. The one rule
 * repeated is the comment one, because it is enforced per turn and the enforcer
 * has no memory of this session either.
 */
const resumedPrompt = (input: WorkerPromptInput) => {
  const thread = renderThread(input.comments, input.readerSessionId);
  return joinSections([
    `# ${input.task.title} — continued`,
    "You have worked on this task before and your session history is intact. What follows is everything added to the task's conversation since you last read it.",
    section(
      "New since your last run",
      thread.length === 0
        ? "Nothing was added. Pick up where you stopped."
        : thread
    ),
    section("Before you finish", WORKER_RULES),
  ]);
};

/**
 * The prompt for one worker dispatch. Pure and total: the session's mode picks
 * the shape, and every other decision above is a property of the rows passed
 * in.
 */
export const buildWorkerPrompt = (input: WorkerPromptInput) =>
  promptOf(input.mode === "fresh" ? freshPrompt(input) : resumedPrompt(input));
