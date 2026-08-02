/**
 * What a run is told, and — the part that matters — what it is not told twice.
 *
 * Two shapes, and the difference between them is the whole steering loop. A
 * fresh session is situated from nothing: the task, the project it belongs to,
 * the checkout it was given, and the standing rules about where output goes. A
 * resumed session already holds every one of those in its own history, so it is
 * given exactly what has arrived since it last read the thread — every comment
 * after its watermark, each labelled with who wrote it. That single mechanism
 * covers the whole review loop with no special-casing: the implementation
 * session comes back and reads "the review session found X" and "you said Y",
 * and it works unchanged for two sessions or ten.
 *
 * The watermark is a `(createdAt, id)` tuple rather than a timestamp, and it is
 * advanced here rather than after the run. Advancing at prompt-build time is
 * what stops a resumed run from reading its own auto-appended fallback comment
 * back as new input — the session's own previous output is in the thread like
 * anything else, and a watermark that only moved on comments written by other
 * people would hand the agent its own words as instructions. It advances to
 * the last comment actually rendered rather than to the newest row, so a comment
 * that lands between the read and the write stays unread instead of being
 * skipped forever.
 *
 * A fresh session takes the same path with a null watermark, which the comment
 * repository reads as "has seen nothing" and answers with the thread from the
 * beginning. That is deliberate: a human who files a task, adds "also do X" as
 * a comment, and drags the card into *in progress* has said something the first
 * run must hear, and one code path is what guarantees it does.
 *
 * The assembly is pure — rows in, string out — so every shape above is testable
 * without a database. {@link buildRunPrompt} is the thin wrapper that fetches
 * the rows and moves the watermark.
 *
 * The prompt text itself never reaches an event: {@link RunPrompt} carries its
 * own length because `promptChars` is the measurement telemetry records, and a
 * prompt on a row is a task brief in a ledger kept for a year.
 */

import {
  AgentSessionRepo,
  CommentRepo,
  type CommentWatermark,
  withActor,
} from "@workspace/db";
import type {
  AgentSession,
  AgentSessionId,
  Comment,
  CommentKind,
} from "@workspace/domain";
import {
  CONTAINER_ARTIFACT_DIR,
  CONTAINER_WORKSPACE_DIR,
  type RunWorkspace,
  type SandboxKind,
} from "@workspace/sandbox";
import { DateTime, Effect } from "effect";
import {
  type DispatchContext,
  sessionIdOf,
  taskIdOf,
  workspaceIdOf,
} from "./dispatch-context";
import { PromptBuildFailed } from "./errors";

/**
 * How much of a session id goes in a label. Enough to tell two sessions on one
 * task apart and to find the row in the dashboard, short enough that the agent
 * reads it as a name rather than as an argument to pass somewhere.
 */
const SESSION_LABEL_CHARS = 8;

/**
 * The directories a run can see, named as the run itself sees them.
 *
 * Not the container constants directly, because the local sandbox runs the same
 * spec as a plain subprocess and rewrites every container path back to the host
 * path its mount pointed at. A prompt that named `/artifacts/task` in that mode
 * would send the agent to write into a directory that does not exist — the one
 * failure that looks like a run that produced nothing.
 */
export interface RunPlacement {
  /** The task's own artifacts folder. The only artifacts folder a run may write. */
  readonly artifactsDir: string;
  /** The branch the checkout is on, or null for a run with no repo. */
  readonly branch: string | null;
  /** The global promoted folder, read-only. */
  readonly globalArtifactsDir: string;
  /** The project's promoted folder, read-only, or null for a task with no project. */
  readonly projectArtifactsDir: string | null;
  /** The repo checkout, or the scratch directory a task with no repo gets. */
  readonly workspaceDir: string;
}

/** Which sandbox served the run, and the directories it was given. */
export interface PlacementInput {
  readonly kind: SandboxKind;
  readonly workspace: RunWorkspace;
}

/**
 * Where the run's files are, from the run's point of view. The two cases mirror
 * what each sandbox implementation actually does — a container sees the fixed
 * mount points, a local process sees the host paths — so the prompt and the
 * process agree on every path in it.
 */
export const placementOf = ({
  kind,
  workspace,
}: PlacementInput): RunPlacement => {
  const { branch } = workspace;
  if (kind === "local") {
    return {
      artifactsDir: workspace.taskArtifactsDir,
      branch,
      globalArtifactsDir: workspace.globalArtifactsDir,
      projectArtifactsDir: workspace.projectArtifactsDir,
      workspaceDir: workspace.workspaceDir,
    };
  }
  return {
    artifactsDir: CONTAINER_ARTIFACT_DIR.task,
    branch,
    globalArtifactsDir: CONTAINER_ARTIFACT_DIR.global,
    // Null stays null: a task with no project has no promoted folder mounted,
    // and naming one the run cannot open is worse than not mentioning it.
    projectArtifactsDir:
      workspace.projectArtifactsDir === null
        ? null
        : CONTAINER_ARTIFACT_DIR.project,
    workspaceDir: CONTAINER_WORKSPACE_DIR,
  };
};

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
const renderComment = (input: CommentLabelInput) =>
  `${commentLabelOf(input)}\n${input.comment.body.trim()}`;

/** The thread, oldest first, blank line between speakers. */
const renderThread = (
  comments: readonly Comment[],
  readerSessionId: AgentSessionId
) =>
  comments
    .map((comment) => renderComment({ comment, readerSessionId }))
    .join("\n\n");

/** Drops the sections a task did not earn and joins what is left. */
const joinSections = (sections: readonly (string | null)[]) =>
  sections.filter((part) => part !== null).join("\n\n");

/** A titled block, or null when there is nothing to put in it. */
const section = (title: string, body: string | null) =>
  body === null || body.trim().length === 0 ? null : `## ${title}\n${body}`;

/**
 * The rule the stop hook enforces, in its positive form.
 *
 * The hook refuses a turn that ends with no comment and feeds its reason back
 * as the next prompt, so the agent will hear this rule either way — but hearing
 * it first, as an instruction, is the difference between a run that comments
 * and a run that spends a turn being told to. The wording tracks
 * `NO_COMMENT_REFUSAL` in `@workspace/harness` on purpose: one rule stated
 * twice, not two rules that nearly agree.
 */
export const COMMENT_INSTRUCTION =
  "Before you end your turn, post a comment on this task: what you did, what changed, and anything the next session or a human reviewer needs to know. A turn that ends without one is sent back to write it.";

/** Where the run works and what survives it. The artifacts rule is one line, deliberately: agents use their own file tools and there is no artifact tool to explain. */
const placementSection = ({
  placement,
  repoUrl,
}: Pick<PromptInput, "placement" | "repoUrl">) => {
  const lines = [
    repoUrl === null
      ? `- \`${placement.workspaceDir}\` is an empty scratch directory. This task has no repo.`
      : `- \`${repoUrl}\` is cloned at \`${placement.workspaceDir}\`${placement.branch === null ? "" : `, on branch \`${placement.branch}\``}. Push that branch and open a pull request when the work is ready.`,
    `- Anything worth keeping goes in \`${placement.artifactsDir}\`; everything else is scratch and dies with the container.`,
    placement.projectArtifactsDir === null
      ? `- Read-only reference material: \`${placement.globalArtifactsDir}\`.`
      : `- Read-only reference material: \`${placement.projectArtifactsDir}\` (this project) and \`${placement.globalArtifactsDir}\`.`,
  ];
  return lines.join("\n");
};

/** The project a task belongs to, as one line of context. */
const projectSection = (project: PromptInput["project"]) => {
  if (project === null) {
    return null;
  }
  return project.description === null
    ? project.name
    : `${project.name} — ${project.description}`;
};

/** A run's prompt, and its length. Measured here so nothing downstream measures it differently. */
export interface RunPrompt {
  /** What `promptChars` on the run's events and its wide event carry. */
  readonly chars: number;
  readonly text: string;
}

/** What the assembly needs: the resolved dispatch, plus the comments it has not seen. */
export interface PromptInput
  extends Pick<DispatchContext, "project" | "repoUrl" | "session" | "task"> {
  /**
   * Every comment after the session's watermark, oldest first. Empty is an
   * ordinary case — a rerun with nothing added — and reads as such.
   */
  readonly comments: readonly Comment[];
  readonly placement: RunPlacement;
}

/** The full situating prompt a session that has never run gets. */
const freshPrompt = (input: PromptInput) => {
  const { placement, project, repoUrl, task } = input;
  return joinSections([
    `# ${task.title}`,
    task.brief.trim(),
    section("Acceptance criteria", task.acceptance),
    section("Project", projectSection(project)),
    section("Where you are working", placementSection({ placement, repoUrl })),
    section(
      "The conversation on this task so far",
      renderThread(input.comments, input.session.session.id)
    ),
    section("Before you finish", COMMENT_INSTRUCTION),
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
const resumedPrompt = (input: PromptInput) => {
  const thread = renderThread(input.comments, input.session.session.id);
  return joinSections([
    `# ${input.task.title} — continued`,
    "You have worked on this task before and your session history is intact. What follows is everything added to the task's conversation since you last read it.",
    section(
      "New since your last run",
      thread.length === 0
        ? "Nothing was added. Pick up where you stopped."
        : thread
    ),
    section("Before you finish", COMMENT_INSTRUCTION),
  ]);
};

/**
 * The prompt for one dispatch. Pure and total: the session's mode picks the
 * shape, and every other decision above is a property of the rows passed in.
 */
export const buildPrompt = (input: PromptInput): RunPrompt => {
  const text =
    input.session.mode === "fresh" ? freshPrompt(input) : resumedPrompt(input);
  return { chars: text.length, text };
};

/**
 * How far this session has read, as the comment repository compares it: both
 * halves or neither. A half-set watermark would be a session that reads part of
 * the thread twice, so the pair is treated as one value everywhere.
 */
export const watermarkOf = (
  session: Pick<AgentSession, "commentWatermarkAt" | "commentWatermarkId">
): CommentWatermark | null =>
  session.commentWatermarkAt === null || session.commentWatermarkId === null
    ? null
    : { createdAt: session.commentWatermarkAt, id: session.commentWatermarkId };

/**
 * Strictly after the watermark, in the `(createdAt, id)` ordering the thread is
 * read in. Ids are uuidv7 and therefore time-ordered, so comparing them settles
 * a same-instant tie the same way the database's uuid comparison does.
 */
const isAfterWatermark = (comment: Comment, watermark: CommentWatermark) => {
  const commentMs = DateTime.toEpochMillis(comment.createdAt);
  const watermarkMs = DateTime.toEpochMillis(watermark.createdAt);
  return commentMs === watermarkMs
    ? comment.id > watermark.id
    : commentMs > watermarkMs;
};

/**
 * The comments a session has genuinely not seen, out of what the repository
 * returned.
 *
 * A second filter over a query that already filtered, and it earns its place:
 * `comment.created_at` is `timestamptz(6)` and the domain's `Timestamp` holds
 * milliseconds, so a watermark is a truncated copy of the comment it names.
 * The database compares the truncation against the full-precision column, finds
 * it smaller, and hands back the very comment the watermark was set to — every
 * resumed run would re-read the last thing it was shown, which for a run whose
 * own fallback comment sits at the end of the thread means reading its own words
 * back as new instructions forever. Comparing in the precision the domain
 * actually has is what closes that.
 */
export const unreadOf = (input: {
  readonly comments: readonly Comment[];
  readonly watermark: CommentWatermark | null;
}) => {
  const { watermark } = input;
  return watermark === null
    ? input.comments
    : input.comments.filter((comment) => isAfterWatermark(comment, watermark));
};

/**
 * The watermark after reading these comments: the last one rendered, or null
 * when there was nothing to read.
 *
 * The *last of the list*, not the newest by timestamp. The thread is ordered by
 * `(createdAt, id)` and compared the same way, so two comments written in the
 * same millisecond are still strictly ordered — taking the maximum timestamp
 * instead would pick one of the pair arbitrarily and skip the other forever.
 */
export const nextWatermarkOf = (
  comments: readonly Comment[]
): CommentWatermark | null => {
  const last = comments.at(-1);
  return last === undefined ? null : { createdAt: last.createdAt, id: last.id };
};

/** One dispatch, and the directories it was given. */
export interface PromptRequest {
  readonly context: DispatchContext;
  readonly placement: RunPlacement;
}

/**
 * Builds the prompt and moves the session's watermark past what went into it.
 *
 * Both halves are one operation because they are one claim: these comments have
 * been delivered. The advance is a write and carries the run's own actor, so
 * the audit log names the orchestrator rather than inheriting whoever provided
 * the store.
 *
 * Every database failure becomes {@link PromptBuildFailed}. The run lifecycle
 * above has one thing to do about a prompt it could not build — fail the
 * attempt and let the retry ladder decide — and it should not have to know the
 * difference between a decode error and a dead connection to do it.
 */
export const buildRunPrompt = Effect.fn("Prompt.build")(function* (
  request: PromptRequest
) {
  const { context } = request;
  const taskId = taskIdOf(context);
  const workspaceId = workspaceIdOf(context);
  const sessionId = sessionIdOf(context);
  const failed = (cause: unknown) => new PromptBuildFailed({ cause, taskId });

  const commentRepo = yield* CommentRepo;
  const sessionRepo = yield* AgentSessionRepo;

  const watermarkRead = watermarkOf(context.session.session);
  const returned = yield* commentRepo
    .since({ taskId, watermark: watermarkRead, workspaceId })
    .pipe(Effect.mapError(failed));
  const comments = unreadOf({ comments: returned, watermark: watermarkRead });

  const prompt = buildPrompt({
    comments,
    placement: request.placement,
    project: context.project,
    repoUrl: context.repoUrl,
    session: context.session,
    task: context.task,
  });

  const watermark = nextWatermarkOf(comments);
  if (watermark !== null) {
    yield* sessionRepo
      .advanceWatermark({
        commentAt: watermark.createdAt,
        commentId: watermark.id,
        id: sessionId,
        workspaceId,
      })
      .pipe(withActor(context.actor), Effect.mapError(failed));
  }

  yield* Effect.annotateCurrentSpan({
    commentsRead: comments.length,
    mode: context.session.mode,
    promptChars: prompt.chars,
    sessionId,
    taskId,
  });

  return prompt;
});
