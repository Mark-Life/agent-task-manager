/**
 * How a run ends. One function, six writes, and a rule that surprises people:
 * **every ending moves the task to review, including the failures.**
 *
 * There is no failed column on the board. A crashed run posts its error text
 * into the thread, its session is marked failed, and a human decides what to do
 * — which is the same gate a clean finish lands in. The alternative is a status
 * that means "an agent broke" and a second review queue nobody reads;
 * summarizing the failure or having an agent answer it are additive changes on
 * top of this, not a reason to hold the task somewhere else in the meantime.
 *
 * A run is the restricted actor on this board: `in_progress → review` is the
 * one move it has. The writes here are performed as the `orchestrator` actor
 * rather than as `worker_run`, and that is deliberate for the failure path —
 * the process that died cannot write its own epitaph, so the loop authors it.
 *
 * **Everything here is best-effort and loud.** The terminal path runs from an
 * `onExit`, which is also the interruption path, so a step that fails must not
 * take the remaining steps with it: a comment the database refused should not
 * be what leaves a task sitting in *in progress* forever. Each write is logged
 * at error level and reported as a flag on {@link TerminalReport}, so the loop
 * above can count what did not happen instead of discovering it a day later.
 *
 * **Lifecycle facts are not comments.** Started, finished, failed, cost and
 * duration go on the run row and into `run_events`; the thread stays a
 * conversation. The only two comments this file writes are the crash text and
 * the fallback — and the fallback exists because a run that forgets the comment
 * tool would otherwise leave the task silent.
 */

import {
  AgentSessionRepo,
  CommentRepo,
  RunRepo,
  TaskRepo,
  withActor,
} from "@workspace/db";
import type { CommentKind, RunOutcome } from "@workspace/domain";
import { commentMarkerPathOf } from "@workspace/harness";
import { Effect } from "effect";
import { FileSystem } from "effect/FileSystem";
import {
  type DispatchContext,
  economicsOf,
  errorFieldsOf,
  isFailure,
  outcomeOfTerminus,
  type RunTerminus,
  sessionIdOf,
  taskIdOf,
  workspaceIdOf,
} from "./dispatch-context";
import { clipToBytes } from "./mapping";

/**
 * How much of a final assistant message survives into a fallback comment.
 *
 * A comment is meant to be read, and a model asked to summarize its work at the
 * end of a long turn occasionally answers with the work. The full text is in
 * the transcript either way, so the thread keeps the first sixteen kilobytes
 * and says that it did — the same order of magnitude the domain allows one run
 * event to carry, for the same reason.
 */
const FALLBACK_BODY_BUDGET_BYTES = 16_384;

/** Appended when a fallback comment was cut, so the reader knows where to look. */
const TRUNCATION_NOTE =
  "\n\n— message clipped; the full text is in the transcript.";

/** What a session that ended without saying why is recorded as. */
const UNSTATED_FAILURE = "the run ended without reporting a reason";

/**
 * Names the tools that post a comment on the task.
 *
 * The orchestrator watches this run's own event stream for the tool result, so
 * the marker file the stop hook reads gets created on the host and the container
 * sees it through the same mount. Matching on the name rather than on an exact
 * tool id is what keeps this working across the two ways the tool arrives — the
 * gateway's own API surface and the same operation exposed through an MCP server
 * that prefixes every name it serves.
 *
 * Over-matching is the safe direction: a run whose comment was miscounted as
 * posted loses a fallback comment, while an unrecognized comment tool means the
 * stop hook refuses a turn that had already done what it was asked.
 */
const COMMENT_TOOL_PATTERN = /comment/i;

/** Whether a tool by this name posts a comment on the task. */
export const isCommentTool = (toolName: string) =>
  COMMENT_TOOL_PATTERN.test(toolName);

/**
 * Runs one terminal write, logging and swallowing anything it fails with.
 *
 * `catchCause` rather than `catchAll` because this path also runs as a
 * finalizer: a defect in a repository would otherwise be a run that never
 * closes, and the point of the whole file is that a run always does.
 */
const bestEffort =
  (step: string) =>
  <A, E, R>(effect: Effect.Effect<A, E, R>) =>
    effect.pipe(
      Effect.catchCause((cause) =>
        Effect.logError(`run terminal: ${step} failed`, cause).pipe(
          Effect.as(null)
        )
      )
    );

/**
 * Stands in for the run row a second closer found already closed. A value
 * rather than null, so `runClosed` on the report stays a statement about the
 * row and not about which of two racing writers got there first.
 */
const ALREADY_CLOSED = "already-closed" as const;

/** `undefined` where the repository means "no number", which is not the same as null. */
const orAbsent = <A>(value: A | null) => value ?? undefined;

/** The crash text, as the thread shows it. Already sanitized by `describeFailure`. */
const errorCommentBody = (terminus: RunTerminus) => {
  const { errorClass, errorMessage } = errorFieldsOf(terminus);
  return `**Run failed — ${errorClass ?? "Unknown"}**\n\n${errorMessage ?? UNSTATED_FAILURE}`;
};

/** The final assistant message, clipped, with the cut stated rather than implied. */
const fallbackCommentBody = (text: string) => {
  const clipped = clipToBytes(text, FALLBACK_BODY_BUDGET_BYTES);
  return clipped.length === text.length ? clipped : clipped + TRUNCATION_NOTE;
};

/** Where this run's marker file lives on the host. */
const markerPathOf = (context: DispatchContext) =>
  commentMarkerPathOf(context.layout);

/**
 * Records that this run has commented, in the one place the stop hook looks.
 *
 * Existence is the whole protocol — the contents are never read — so an empty
 * file is a complete implementation and a half-written one cannot be misread.
 * A failure to write it costs the enforcement, not the run: the fallback
 * comment covers the same rule from the other side, which is why this is
 * swallowed rather than raised.
 */
export const markCommentPosted = Effect.fn("Run.markCommentPosted")(function* (
  context: DispatchContext
) {
  const fs = yield* FileSystem;
  const path = markerPathOf(context);
  yield* fs.writeFileString(path, "").pipe(
    Effect.tapError((cause) =>
      Effect.logWarning("comment marker not written", { cause, path })
    ),
    Effect.ignore
  );
});

/**
 * Whether this run posted a comment, as the marker file reports it.
 *
 * Read at close as well as tracked through the stream, because the marker has
 * two authors: the loop creates it on seeing the tool result, and a provider
 * that wires the comment tool in-process may create it directly. An unreadable
 * marker answers false — which costs a duplicate-looking fallback comment, and
 * never a task left silent.
 */
export const commentMarkerSeen = Effect.fn("Run.commentMarkerSeen")(function* (
  context: DispatchContext
) {
  const fs = yield* FileSystem;
  return yield* fs
    .exists(markerPathOf(context))
    .pipe(Effect.orElseSucceed(() => false));
});

/** What closing a run out needs beyond the context it ran under. */
export interface RunClosure {
  /** The branch the checkout pushed, or null for a run with no repo. */
  readonly branch: string | null;
  /** Whether the run posted a comment of its own. Decides the fallback. */
  readonly commentPosted: boolean;
  readonly context: DispatchContext;
  readonly terminus: RunTerminus;
}

/**
 * What the terminal path managed to do. Flags rather than a thrown failure,
 * because every step here is best-effort and the caller's question is which
 * ones did not land — a run that closed but did not move its task is a
 * different problem from one that did neither.
 */
export interface TerminalReport {
  /** Whether the run had commented by the time it ended, marker included. */
  readonly commentPosted: boolean;
  readonly errorCommented: boolean;
  readonly fallbackCommented: boolean;
  readonly outcome: RunOutcome;
  readonly runClosed: boolean;
  readonly sessionEnded: boolean;
  /** Whether the task actually reached *review*. */
  readonly transitioned: boolean;
}

/** The two comment kinds this file writes, named where they are decided. */
const ERROR_COMMENT: CommentKind = "run_error";
const FALLBACK_COMMENT: CommentKind = "fallback";

/**
 * Closes one run out: the run row, the session, the two comments, and the move
 * to *review*.
 *
 * The order is the order a reader wants it in. The run row closes first, so the
 * task stops looking live the moment anything is written at all. The comments
 * land before the transition, so a dashboard that reacts to the status change
 * finds the thread already complete. The session ends after the comments,
 * because a failed session's message is the same text the crash comment
 * carries and writing it twice from two places is how the two come to differ.
 *
 * Total by construction: every failure is logged and reported as a flag. The
 * two refusals worth naming are ordinary rather than exceptional — a run closed
 * twice (`RunRepo.NotLive`) is the stop path and this path agreeing, and an
 * illegal transition is a human having moved the card while the run was going.
 */
export const closeRun = Effect.fn("Run.close")(function* (closure: RunClosure) {
  const { branch, context, terminus } = closure;
  const runs = yield* RunRepo;
  const sessions = yield* AgentSessionRepo;
  const comments = yield* CommentRepo;
  const tasks = yield* TaskRepo;

  const asActor = withActor(context.actor);
  const workspaceId = workspaceIdOf(context);
  const taskId = taskIdOf(context);
  const sessionId = sessionIdOf(context);
  const outcome = outcomeOfTerminus(terminus);
  const fields = errorFieldsOf(terminus);
  const failed = isFailure(terminus);

  yield* Effect.annotateCurrentSpan({
    kind: terminus.kind,
    outcome,
    runId: context.runId,
    taskId,
  });

  // The provider's own id for the conversation, which is the only thing a
  // resume can be built from. Written before anything else can refuse: a
  // session whose id was never recorded starts over on its next run, with the
  // history intact on disk and unreachable.
  const { providerSessionId } = terminus;
  if (
    providerSessionId !== null &&
    providerSessionId !== context.session.session.providerSessionId
  ) {
    yield* asActor(
      sessions.recordProviderSession({
        id: sessionId,
        providerSessionId,
        workspaceId,
      })
    ).pipe(bestEffort("recording the provider session id"));
  }

  const economics = economicsOf(terminus);
  // `RunRepo.NotLive` is the one refusal here that means the work is already
  // done: the stop path and this path agreeing, or a reconcile that closed the
  // row before its context was rebuilt. Reported as closed, because it is —
  // logging it as a failed step would put a working race in the error budget.
  const closed = yield* asActor(
    runs.close({
      branch: orAbsent(branch),
      costUsd: orAbsent(economics.costUsd),
      durationMs: orAbsent(economics.durationMs),
      errorClass: orAbsent(fields.errorClass),
      errorMessage: orAbsent(fields.errorMessage),
      exitCode: orAbsent(terminus.exitCode),
      id: context.runId,
      outcome,
      totalTokens: orAbsent(economics.totalTokens),
      turns: orAbsent(economics.turns),
      workspaceId,
    })
  ).pipe(
    Effect.catchTag("RunRepo.NotLive", () =>
      Effect.as(
        Effect.logInfo(
          `run ${context.runId} had already closed when the terminal path reached it`
        ),
        ALREADY_CLOSED
      )
    ),
    bestEffort("closing the run row")
  );

  // The crash comment. Authored by the orchestrator rather than by the agent,
  // because the run that produced the error is the one that could not write it.
  const errorComment = failed
    ? yield* asActor(
        comments.append({
          author: { kind: "orchestrator", runId: context.runId },
          body: errorCommentBody(terminus),
          kind: ERROR_COMMENT,
          taskId,
          workspaceId,
        })
      ).pipe(bestEffort("posting the crash comment"))
    : null;

  // The braces to the stop hook's belt. Only when the run posted nothing of its
  // own, and only when it actually said something — an empty final message is a
  // run that had nothing to add, not a comment worth collapsing in the UI.
  const wantsFallback =
    !closure.commentPosted && terminus.finalText.trim().length > 0;
  const fallbackComment = wantsFallback
    ? yield* asActor(
        comments.append({
          author: { kind: "agent", runId: context.runId, sessionId },
          body: fallbackCommentBody(terminus.finalText),
          kind: FALLBACK_COMMENT,
          taskId,
          workspaceId,
        })
      ).pipe(bestEffort("posting the fallback comment"))
    : null;

  const ended = yield* asActor(
    failed
      ? sessions.fail({
          errorMessage: fields.errorMessage ?? UNSTATED_FAILURE,
          id: sessionId,
          workspaceId,
        })
      : sessions.finish({ id: sessionId, workspaceId })
  ).pipe(bestEffort("ending the session"));

  // The one move a run may make, and it is the same move for all three
  // endings. `after` is deliberately absent: the card goes to the bottom of
  // review, because nobody dragged it there.
  const moved = yield* asActor(
    tasks.transition({ id: taskId, to: "review", workspaceId })
  ).pipe(bestEffort("moving the task to review"));

  return {
    commentPosted: closure.commentPosted,
    errorCommented: errorComment !== null,
    fallbackCommented: fallbackComment !== null,
    outcome,
    runClosed: closed !== null,
    sessionEnded: ended !== null,
    transitioned: moved !== null,
  } satisfies TerminalReport;
});
