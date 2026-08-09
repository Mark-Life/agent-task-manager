/**
 * How a run ends. One function, six writes, and a rule that surprises people:
 * **every ending of a worker run moves its task to review, including the
 * failures.**
 *
 * There is no failed column on the board. A crashed run posts its error text
 * into the thread, its session is marked failed, and a human decides what to do
 * — which is the same gate a clean finish lands in. The alternative is a status
 * that means "an agent broke" and a second review queue nobody reads;
 * summarizing the failure or having an agent answer it are additive changes on
 * top of this, not a reason to hold the task somewhere else in the meantime.
 *
 * **A run somebody ended is not a run that broke.** A stop, and the loop going
 * down under a run, both leave a notice on the thread saying so — the reader
 * should know why it stopped talking — but the session is *finished* rather
 * than failed, because nothing about the conversation went wrong and a failed
 * session is one nothing may resume. That is what makes Stop-then-Rerun carry
 * on rather than start over with the history on disk and unreachable.
 *
 * A run is the restricted actor on this board: `in_progress → review` is the
 * one move it has. The writes here are performed as the `orchestrator` actor
 * rather than as `worker_run`, and that is deliberate for the failure path —
 * the process that died cannot write its own epitaph, so the loop authors it.
 *
 * **A manager run ends here too, and takes the same path.** The run row, the
 * session ending, the economics and the wide event are shared; what a role
 * changes is only what the ending is written back to — a message and a board
 * move for a task, a chat reply for a conversation, which is `./chat-turn`. A run
 * with no task makes no board move because there is no card to move, and that
 * is the one branch below.
 *
 * **Everything here is best-effort and loud.** The terminal path runs from an
 * `onExit`, which is also the interruption path, so a step that fails must not
 * take the remaining steps with it: a message the database refused should not
 * be what leaves a task sitting in *in progress* forever. Each write is logged
 * at error level and reported as a flag on {@link TerminalReport}, so the loop
 * above can count what did not happen instead of discovering it a day later.
 *
 * **Lifecycle facts are not task messages.** Started, finished, failed, cost and
 * duration go on the run row and into `run_events`; the thread stays a
 * conversation. The only two messages this file writes are the crash text and
 * the fallback — and the fallback exists because a run that forgets the message
 * tool would otherwise leave the task silent.
 *
 * **The pull request is written here for the same reason the fallback is.** A
 * worker that opened one says so in its message, in prose, and the card's own
 * `prUrl` column stayed null on every task this board has ever run. Closing the
 * run asks GitHub what pull request the run's branch has and writes the answer
 * onto the task — see `pullRequestForBranch` — so the field is a fact the loop
 * observed rather than a step at the end of a long turn that a model has to
 * remember. It runs on every ending, crashes included, because a run that opened
 * a pull request and then died is exactly the one whose link is worth keeping.
 */

import {
  AgentSessionRepo,
  RunRepo,
  TaskMessageRepo,
  TaskRepo,
  withActor,
} from "@workspace/db";
import type { RunOutcome, TaskMessageKind } from "@workspace/domain";
import { messageMarkerPathOf } from "@workspace/harness";
import { pullRequestForBranch } from "@workspace/sandbox";
import { Effect } from "effect";
import { FileSystem } from "effect/FileSystem";
import { closeChatTurn } from "./chat-turn";
import {
  type DispatchContext,
  economicsOf,
  errorFieldsOf,
  isFailure,
  isInterrupt,
  outcomeOfTerminus,
  type RunTerminus,
  sessionIdOf,
  workspaceIdOf,
} from "./dispatch-context";
import { readHandoff } from "./handoff";
import { clipToBytes } from "./mapping";
import type { WorkerAttachment } from "./subject";

/**
 * How much of a final assistant message survives into a fallback message.
 *
 * A message is meant to be read, and a model asked to summarize its work at the
 * end of a long turn occasionally answers with the work. The full text is in
 * the transcript either way, so the thread keeps the first sixteen kilobytes
 * and says that it did — the same order of magnitude the domain allows one run
 * event to carry, for the same reason.
 */
const FALLBACK_BODY_BUDGET_BYTES = 16_384;

/** Appended when a fallback message was cut, so the reader knows where to look. */
const TRUNCATION_NOTE =
  "\n\n— message clipped; the full text is in the transcript.";

/** What a session that ended without saying why is recorded as. */
const UNSTATED_FAILURE = "the run ended without reporting a reason";

/**
 * Names the tools that post a message on the task.
 *
 * The orchestrator watches this run's own event stream for the tool result, so
 * the marker file the stop hook reads gets created on the host and the container
 * sees it through the same mount. Matching on the name rather than on an exact
 * tool id is what keeps this working across the two ways the tool arrives — the
 * gateway's own API surface and the same operation exposed through an MCP server
 * that prefixes every name it serves.
 *
 * Over-matching is the safe direction, and this deliberately still does: it
 * catches `messages_list` and a chat read as well as `messages_post`. A run
 * whose message was miscounted as posted loses a fallback message, while an
 * unrecognized posting tool means the stop hook refuses a turn that had already
 * done what it was asked.
 */
const MESSAGE_TOOL_PATTERN = /message/i;

/** Whether a tool by this name posts a message on the task. */
export const isMessageTool = (toolName: string) =>
  MESSAGE_TOOL_PATTERN.test(toolName);

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

/**
 * The first line of the notice a run that did not finish cleanly leaves on its
 * task.
 *
 * A run somebody ended gets a heading of its own, and the difference is the
 * point: "Run failed — Unknown" over a person's own Stop is what sends the next
 * reader looking for a bug that is not there. The sentence under it already
 * says which interrupt and who asked, so the heading only has to separate "this
 * broke" from "this was ended".
 */
const headingOf = (terminus: RunTerminus, errorClass: string | null) => {
  if (!isInterrupt(terminus)) {
    return `Run failed — ${errorClass ?? "Unknown"}`;
  }
  return terminus.kind === "failed" && terminus.interruptReason === "stopped"
    ? "Run stopped"
    : "Run interrupted";
};

/** The crash text, as the thread shows it. Already sanitized by `describeFailure`. */
const errorMessageBody = (terminus: RunTerminus) => {
  const { errorClass, errorMessage } = errorFieldsOf(terminus);
  return `**${headingOf(terminus, errorClass)}**\n\n${errorMessage ?? UNSTATED_FAILURE}`;
};

/** The final assistant message, clipped, with the cut stated rather than implied. */
const fallbackMessageBody = (text: string) => {
  const clipped = clipToBytes(text, FALLBACK_BODY_BUDGET_BYTES);
  return clipped.length === text.length ? clipped : clipped + TRUNCATION_NOTE;
};

/**
 * Says the message came out of a file rather than off the wire.
 *
 * Worth a line because the two are not the same claim. A message the agent
 * posted is the agent choosing to say that; a handoff is a file the loop found
 * and attached, and a reader deciding whether to trust it wants to know which
 * they are looking at. The path is named so the artifact is findable beside it.
 */
const handoffNote = (path: string) =>
  `_Attached from \`${path}\` — this run could not post it itself._\n\n`;

/** A handoff as the card shows it: the note, then the file, clipped as one body. */
const handoffMessageBody = (input: {
  readonly body: string;
  readonly path: string;
}) => handoffNote(input.path) + fallbackMessageBody(input.body);

/** Where this run's marker file lives on the host. */
const markerPathOf = (context: DispatchContext) =>
  messageMarkerPathOf(context.layout);

/**
 * Records that this run has posted, in the one place the stop hook looks.
 *
 * Existence is the whole protocol — the contents are never read — so an empty
 * file is a complete implementation and a half-written one cannot be misread.
 * A failure to write it costs the enforcement, not the run: the fallback
 * message covers the same rule from the other side, which is why this is
 * swallowed rather than raised.
 */
export const markMessagePosted = Effect.fn("Run.markMessagePosted")(function* (
  context: DispatchContext
) {
  const fs = yield* FileSystem;
  const path = markerPathOf(context);
  yield* fs.writeFileString(path, "").pipe(
    Effect.tapError((cause) =>
      Effect.logWarning("message marker not written", { cause, path })
    ),
    Effect.ignore
  );
});

/**
 * Whether this run posted a message, as the marker file reports it.
 *
 * Read at close as well as tracked through the stream, because the marker has
 * two authors: the loop creates it on seeing the tool result, and a provider
 * that wires the message tool in-process may create it directly. An unreadable
 * marker answers false — which costs a duplicate-looking fallback message, and
 * never a task left silent.
 */
export const messageMarkerSeen = Effect.fn("Run.messageMarkerSeen")(function* (
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
  readonly context: DispatchContext;
  /**
   * Where the artifacts tree lives, which is where a run that could not reach
   * the board left its handoff. Passed in rather than read off the context: the
   * context carries the run's own layout, and the artifact folders are siblings
   * of it rather than anything under it.
   */
  readonly dataRoot: string;
  /** Whether the run posted a message of its own. Decides the fallback. */
  readonly messagePosted: boolean;
  readonly terminus: RunTerminus;
}

/**
 * What the terminal path managed to do. Flags rather than a thrown failure,
 * because every step here is best-effort and the caller's question is which
 * ones did not land — a run that closed but did not move its task is a
 * different problem from one that did neither.
 */
export interface TerminalReport {
  /** Whether the manager's answer reached its conversation. False on every worker run. */
  readonly answerStored: boolean;
  readonly errorPosted: boolean;
  readonly fallbackPosted: boolean;
  /**
   * Whether the fallback message came off disk rather than out of the stream.
   * Counted separately because it is the one that says the board write path
   * failed and the recovery worked — the number an operator wants is how often
   * that happens, not how often a message was posted for a run.
   */
  readonly handoffAttached: boolean;
  /** Whether the run had posted by the time it ended, marker included. */
  readonly messagePosted: boolean;
  readonly outcome: RunOutcome;
  /**
   * The pull request the task's own column holds now that the run has closed,
   * and null when it holds none. Not "what this run opened": a rerun that
   * changed nothing reports the link the task already had, which is the honest
   * reading of a field that describes the task rather than the attempt.
   */
  readonly prUrl: string | null;
  readonly runClosed: boolean;
  readonly sessionEnded: boolean;
  /**
   * Whether the task actually reached *review*. True on a manager run, which
   * has no card to move and therefore nothing left undone — the flag is read as
   * "is anything still stuck in the column", and a run with no column is not.
   */
  readonly transitioned: boolean;
}

/** The two message kinds this file writes, named where they are decided. */
const ERROR_MESSAGE_KIND: TaskMessageKind = "run_error";
const FALLBACK_MESSAGE_KIND: TaskMessageKind = "fallback";

/** What a worker run's ending wrote onto its task. */
interface BoardWrites {
  readonly errorPosted: boolean;
  readonly fallbackPosted: boolean;
  readonly handoffAttached: boolean;
  readonly prUrl: string | null;
  readonly transitioned: boolean;
}

/**
 * A manager run has no card, so there is nothing here it left undone.
 * `transitioned` is true because the caller reads it as "is this still stuck in
 * the column", and a run with no column is not.
 */
const NO_BOARD_WRITES: BoardWrites = {
  errorPosted: false,
  fallbackPosted: false,
  handoffAttached: false,
  prUrl: null,
  transitioned: true,
};

/**
 * The pull request this run's branch has, onto the task that owns the branch.
 *
 * Answers the URL the card's column ends up holding, and null for the ordinary
 * case — a run that produced a document, an answer or nothing has no pull
 * request, and the lookup says so rather than this having to guess from what the
 * agent wrote.
 *
 * Written only when it would change the row. A task whose field already holds
 * this link is every rerun after the first, and an `UPDATE` per rerun would be
 * an audit entry per rerun recording that nothing moved.
 *
 * Best-effort in both halves and deliberately after the messages: the link is in
 * the thread already, posted by the agent or by the fallback, so a GitHub that
 * will not answer or a write the database refuses costs the structured field and
 * never the link itself.
 */
const recordPullRequest = Effect.fnUntraced(function* (input: {
  readonly closure: RunClosure;
  readonly task: WorkerAttachment["task"];
}) {
  const { closure, task } = input;
  const { context } = closure;
  const tasks = yield* TaskRepo;

  // Total by contract — every refusal GitHub can make is already an answer of
  // null in there — so there is nothing here for `bestEffort` to catch.
  const found = yield* pullRequestForBranch({
    branch: closure.branch,
    repoUrl: context.repoUrl,
  });

  if (found === null || found === task.prUrl) {
    return found ?? task.prUrl;
  }

  const written = yield* withActor(context.actor)(
    tasks.update({
      fields: { prUrl: found },
      id: task.id,
      workspaceId: workspaceIdOf(context),
    })
  ).pipe(bestEffort("recording the pull request on the task"));

  // The URL either way, because it is what this run's branch has whether or not
  // the column took it — and the log above says which happened.
  return written === null ? task.prUrl : found;
});

/**
 * The two messages and the board move, for a run that has a task.
 *
 * The messages land before the transition, so a dashboard that reacts to the
 * status change finds the thread already complete.
 */
const closeOnTask = Effect.fnUntraced(function* (input: {
  readonly attached: WorkerAttachment;
  readonly closure: RunClosure;
}) {
  const { closure } = input;
  const { context, terminus } = closure;
  const messages = yield* TaskMessageRepo;
  const tasks = yield* TaskRepo;

  const asActor = withActor(context.actor);
  const taskId = input.attached.task.id;
  const workspaceId = workspaceIdOf(context);
  const sessionId = sessionIdOf(context);

  // The crash message. Authored by the orchestrator rather than by the agent,
  // because the run that produced the error is the one that could not write it.
  const errorMessage = isFailure(terminus)
    ? yield* asActor(
        messages.post({
          author: { kind: "orchestrator", runId: context.runId },
          body: errorMessageBody(terminus),
          kind: ERROR_MESSAGE_KIND,
          taskId,
          workspaceId,
        })
      ).pipe(bestEffort("posting the crash message"))
    : null;

  // The braces to the stop hook's belt, from whichever source still has the
  // run's words. Only when the run posted nothing of its own.
  //
  // The handoff is read first and wins, because the case the two are competing
  // over is the one it was written for: a run that lost the board wrote the
  // file *because* it could not post, and its final message is then the
  // narration of that failure rather than the work. A run that never lost the
  // board writes no handoff, so this costs one `stat` on the ordinary path.
  //
  // Read even when there is nothing to fall back to otherwise — a run killed
  // mid-sentence has no final message at all, and its handoff is the only
  // thing left of it.
  const handoff = closure.messagePosted
    ? null
    : yield* readHandoff({ dataRoot: closure.dataRoot, taskId }).pipe(
        bestEffort("reading the handoff off disk")
      );

  // An empty final message is a run that had nothing to add, not a message
  // worth collapsing in the UI. A handoff is never empty — `readHandoff`
  // answers null for a blank file.
  const fallbackBody = (() => {
    if (closure.messagePosted) {
      return null;
    }
    if (handoff !== null) {
      return handoffMessageBody(handoff);
    }
    return terminus.finalText.trim().length > 0
      ? fallbackMessageBody(terminus.finalText)
      : null;
  })();

  const fallbackMessage =
    fallbackBody === null
      ? null
      : yield* asActor(
          messages.post({
            author: { kind: "agent", runId: context.runId, sessionId },
            body: fallbackBody,
            kind: FALLBACK_MESSAGE_KIND,
            taskId,
            workspaceId,
          })
        ).pipe(bestEffort("posting the fallback message"));

  // Before the move, so a dashboard woken by the status change finds the card
  // already carrying its link — the same ordering, and the same reason, as the
  // messages above.
  const prUrl = yield* recordPullRequest({
    closure,
    task: input.attached.task,
  });

  // The one move a run may make, and it is the same move for all three
  // endings. `after` is deliberately absent: the card goes to the bottom of
  // review, because nobody dragged it there.
  const moved = yield* asActor(
    tasks.transition({ id: taskId, to: "review", workspaceId })
  ).pipe(bestEffort("moving the task to review"));

  return {
    errorPosted: errorMessage !== null,
    fallbackPosted: fallbackMessage !== null,
    handoffAttached: handoff !== null && fallbackMessage !== null,
    prUrl,
    transitioned: moved !== null,
  } satisfies BoardWrites;
});

/**
 * Closes one run out: the run row, whatever it was attached to, and the
 * session.
 *
 * The order is the order a reader wants it in. A conversation's answer goes
 * first, because the interface reading it is woken by an event this path has
 * not caught up with yet and uses the closed run row as the signal that it has
 * — see `closeChatTurn`. The run row closes next, so the work stops looking
 * live the moment anything else is written at all, and a task's messages and
 * board move follow it — see {@link closeOnTask}. The session ends last,
 * because a failed session's message is the same text the crash message carries
 * and writing it twice from two places is how the two come to differ.
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

  const asActor = withActor(context.actor);
  const workspaceId = workspaceIdOf(context);
  const sessionId = sessionIdOf(context);
  const outcome = outcomeOfTerminus(terminus);
  const fields = errorFieldsOf(terminus);
  // The notice on the thread goes on every ending that is not a clean finish, a
  // stop included — see `closeOnTask`, and the thread should say why the run
  // stopped talking either way. The session is the other question, and it has a
  // different answer: only a run that actually broke leaves one that nothing
  // may pick up again.
  const broke = isFailure(terminus) && !isInterrupt(terminus);

  yield* Effect.annotateCurrentSpan({
    kind: terminus.kind,
    outcome,
    role: context.attached.role,
    runId: context.runId,
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

  // The conversation's answer, written *before* the run row closes.
  //
  // The order is the contract with every reader of a finished turn. The bot is
  // woken by the terminal run event, waits for the run to stop reading as live,
  // and then looks for the message — so a run that reads as ended and has no
  // answer beside it is a turn that said nothing, rather than a turn whose
  // answer had not been written yet. Reversed, the chat says "the turn ended
  // without an answer" about a turn that answered.
  const answerStored =
    context.attached.role === "manager"
      ? yield* closeChatTurn({ context, terminus })
      : false;

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

  // The other half of what the ending is written back to: a task's messages and
  // its board move. After the close, so the card stops looking live the moment
  // anything at all is written, and before the session ends, so a dashboard
  // reacting to either finds the record already complete.
  const board =
    context.attached.role === "worker"
      ? yield* closeOnTask({ attached: context.attached, closure })
      : NO_BOARD_WRITES;

  // A failed session is one nothing may resume, so what lands here decides
  // whether Stop-then-Rerun continues the conversation or starts over with the
  // history intact on disk and unreachable. A run somebody ended, and one the
  // loop was carrying when it went down, both leave a session that is fine —
  // nothing about the conversation went wrong — so both finish it.
  const ended = yield* asActor(
    broke
      ? sessions.fail({
          errorMessage: fields.errorMessage ?? UNSTATED_FAILURE,
          id: sessionId,
          workspaceId,
        })
      : sessions.finish({ id: sessionId, workspaceId })
  ).pipe(bestEffort("ending the session"));

  return {
    answerStored,
    errorPosted: board.errorPosted,
    fallbackPosted: board.fallbackPosted,
    handoffAttached: board.handoffAttached,
    messagePosted: closure.messagePosted,
    outcome,
    prUrl: board.prUrl,
    runClosed: closed !== null,
    sessionEnded: ended !== null,
    transitioned: board.transitioned,
  } satisfies TerminalReport;
});
