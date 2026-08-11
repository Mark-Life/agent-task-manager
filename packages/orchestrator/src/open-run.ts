/**
 * Turning a claim into a run: which session it continues, which attempt it is,
 * and everything the later stages read off one immutable record.
 *
 * Nothing here touches a disk and nothing here decides *whether* to run — the
 * dispatcher has already decided that. What is left is the set of questions a
 * run cannot be started without an answer to, asked once so no later stage asks
 * them again and gets a different answer.
 *
 * Both roles open the same way, and that is the point rather than a
 * coincidence: a session row, a run row, one attempt. The attachment is
 * branched on exactly three times — which selection resolves the session, which
 * image runs, and whether there is a repo — and each of those is one of the
 * four things a role is allowed to change.
 */

import { AgentSessionRepo, RunRepo, TaskRepo, withActor } from "@workspace/db";
import {
  Actor,
  isResumable,
  type NextSession,
  nextSessionOf,
  type Project,
  type RunTrigger,
  type SessionProvider,
} from "@workspace/domain";
import { hostRunLayout } from "@workspace/harness";
import { sandboxImageFor } from "@workspace/sandbox";
import { Effect } from "effect";
import type { DispatchContext, ResolvedSession } from "./dispatch-context";
import { AlreadyLive, DispatchFailed, describeFailure } from "./errors";
import {
  type RunAttachment,
  subjectOfAttachment,
  workspaceIdOfAttachment,
} from "./subject";

/**
 * What one dispatch has decided before any row exists.
 *
 * Deliberately short of everything a {@link DispatchContext} carries: the run
 * id, the session, the layout, the image and the repo are all *answers*, and
 * {@link openRun} is where they are worked out. A caller that assembled them
 * itself would be a second place deciding which session a `latest` selection
 * resolves to.
 */
export interface RunClaim {
  /** The task or the conversation this run is for, which is also its role. */
  readonly attached: RunAttachment;
  /** 1-based. The retry ladder and the park decision both count from here. */
  readonly attempt: number;
  readonly dataRoot: string;
  /** Used when no resumable session names one of its own. */
  readonly defaultProvider: SessionProvider;
  /** Which loop is acting, as the audit log records it. */
  readonly loopInstance: string;
  /** Null for a task with no project, and for every manager run. */
  readonly project: Project | null;
  /** How long the work waited between becoming ready and this claim. */
  readonly queueWaitMs: number;
  /** The claim span, captured at the top so an `onExit` emit still has it. */
  readonly spanId: string | null;
  readonly traceId: string | null;
  /** W3C `traceparent` for the container, so the turns inside it join this trace. */
  readonly traceparent: string | null;
  readonly trigger: RunTrigger;
}

/**
 * A conversation always continues its newest session, so its selection is a
 * constant. There is no per-thread override column and deliberately so: a
 * thread that should start over is a new thread, which is a row a person can
 * see rather than a flag they cannot.
 */
const THREAD_SELECTION: NextSession = { mode: "latest" };

/**
 * Which conversation this run continues, and what the task asked for.
 *
 * The answer is a session this run may actually resume, or null — `isResumable`
 * has already been applied by the time this returns, so no later stage asks the
 * question again with less to go on.
 *
 * The two lookups apply it from opposite ends and that is why only one of them
 * calls it here. `latest` is a search — which session, out of however many the
 * subject has — so the rule has to be inside the query that walks them, and the
 * repository owns it. A pin is a check on a session already named, so the
 * candidate comes back whole and the rule is applied at this line, where a
 * reader looking for the resume decision will look. `new` asks nothing: it is
 * the one selection that is an instruction rather than a lookup.
 *
 * A pin whose session has been deleted, or whose session the rule refuses,
 * degrades to a fresh one rather than failing the dispatch: the selection is a
 * preference, and work that cannot start is a worse answer than work that
 * starts clean.
 */
const selectSession = Effect.fnUntraced(function* (input: {
  readonly asActor: <A, E, R>(
    effect: Effect.Effect<A, E, R>
  ) => Effect.Effect<A, E, R>;
  readonly attached: RunAttachment;
}) {
  const sessions = yield* AgentSessionRepo;
  const { asActor, attached } = input;
  const subject = subjectOfAttachment(attached);
  const workspaceId = workspaceIdOfAttachment(attached);
  const selection =
    attached.role === "worker"
      ? nextSessionOf(attached.task)
      : THREAD_SELECTION;

  if (selection.mode === "specific") {
    const pinned = yield* asActor(
      sessions.resumeCandidate({ id: selection.sessionId, workspaceId })
    );
    return {
      resumable: pinned !== null && isResumable(pinned) ? pinned.session : null,
      selection,
    } as const;
  }
  if (selection.mode === "latest") {
    return {
      resumable: yield* asActor(
        sessions.latestResumable({ subject, workspaceId })
      ),
      selection,
    } as const;
  }
  return { resumable: null, selection } as const;
});

/** The image this run's container is started from. One of the four role knobs. */
const imageOf = (attached: RunAttachment) =>
  sandboxImageFor(
    attached.role === "worker" ? attached.task.sandboxImage : null
  );

/**
 * The repo to clone, already resolved: the task's override, else the project's,
 * else null. A manager run has no checkout at all, which is the same null.
 */
const repoUrlOf = (claim: RunClaim) =>
  claim.attached.role === "worker"
    ? (claim.attached.task.repoUrl ?? claim.project?.repoUrl ?? null)
    : null;

/**
 * Opens the session, claims the attempt, and answers with the context every
 * later stage reads.
 *
 * The session comes first and the run row names it, which is the order the
 * domain requires — a process that dies in between leaves a running session
 * with no runs, a state the reconcile already knows how to close, whereas a run
 * with no session is a row that cannot be resumed or attributed.
 */
const claimRun = Effect.fn("Run.open")(function* (claim: RunClaim) {
  const runs = yield* RunRepo;
  const sessions = yield* AgentSessionRepo;
  const tasks = yield* TaskRepo;

  const { attached } = claim;
  const subject = subjectOfAttachment(attached);
  const workspaceId = workspaceIdOfAttachment(attached);
  const asActor = withActor(
    Actor.cases.orchestrator.make({ loopInstance: claim.loopInstance })
  );

  yield* Effect.annotateCurrentSpan({
    attempt: claim.attempt,
    role: attached.role,
    subjectId: subject.id,
    subjectKind: subject.kind,
  });

  const { resumable, selection } = yield* selectSession({ asActor, attached });
  // A conversation names its own provider; a task takes the loop's default
  // unless a session it is resuming already chose one.
  const provider =
    resumable?.provider ??
    (attached.role === "manager"
      ? attached.thread.provider
      : claim.defaultProvider);
  // A session's status, ending and error message describe its most recent run,
  // and this run is about to be a newer one. Put back to running here rather
  // than left as it was, because the repository refuses to end a session that
  // has already ended: without this the close of every resumed run is refused
  // and the row keeps reporting the ending before last. Skipped where it is
  // already running — a no-op UPDATE still costs an audit row.
  const resumed =
    resumable === null || resumable.status === "running"
      ? resumable
      : yield* asActor(sessions.reopen({ id: resumable.id, workspaceId }));
  const session =
    resumed ??
    (yield* asActor(sessions.open({ provider, subject, workspaceId })));

  // A resumed session with no provider id has a row and no conversation behind
  // it — a session opened by a run that died before the harness answered. It is
  // resumed in every other sense and started fresh in the only one that counts.
  const resolved: ResolvedSession =
    resumed !== null && resumed.providerSessionId !== null
      ? {
          mode: "resumed",
          providerSessionId: resumed.providerSessionId,
          selected: selection.mode,
          session: resumed,
        }
      : { mode: "fresh", selected: selection.mode, session };

  // A selection is spent by the run that chose it, and the row that comes back
  // is the one every later stage reads: a context carrying the pre-clear task
  // would report a pin this run has already consumed. Skipped where the task
  // already sits on the default — an UPDATE that changes nothing still costs an
  // audit row, and a trail full of no-op rows is a trail nobody reads.
  const spent =
    attached.role === "worker" &&
    (attached.task.nextSessionId !== null || attached.task.nextSessionNew)
      ? {
          role: "worker" as const,
          task: yield* asActor(
            tasks.clearNextSession({ id: attached.task.id, workspaceId })
          ),
        }
      : attached;

  const run = yield* asActor(
    runs.create({
      agentSessionId: session.id,
      attempt: claim.attempt,
      provider,
      subject,
      traceId: claim.traceId ?? undefined,
      trigger: claim.trigger,
      workspaceId,
    })
  );

  return {
    // Every write this run makes names the run it made them for, which is what
    // "what did this attempt touch" reads off the audit log.
    actor: Actor.cases.orchestrator.make({
      loopInstance: claim.loopInstance,
      runId: run.id,
    }),
    attached: spent,
    attempt: run.attempt,
    image: imageOf(attached),
    layout: hostRunLayout({ dataRoot: claim.dataRoot, runId: run.id }),
    project: claim.project,
    provider,
    queueWaitMs: claim.queueWaitMs,
    repoUrl: repoUrlOf(claim),
    runId: run.id,
    session: resolved,
    spanId: claim.spanId,
    traceId: claim.traceId,
    traceparent: claim.traceparent,
    trigger: claim.trigger,
  } satisfies DispatchContext;
});

/**
 * Opens a run, with every way the opening writes can fail given one of two
 * names.
 *
 * `RunRepo.AlreadyLive` is the failure that is not one: the partial unique
 * index refusing a second live run is the concurrency guard working, and the
 * dispatcher's answer is to skip. Everything else — a missing task, a row that
 * no longer decodes, a database that is down — is a dispatch that did not
 * happen, carrying the cause whole for the log and one sanitized line for the
 * row.
 */
export const openRun = (claim: RunClaim) =>
  claimRun(claim).pipe(
    Effect.catch((error) => {
      const subject = subjectOfAttachment(claim.attached);
      return Effect.fail(
        error._tag === "RunRepo.AlreadyLive"
          ? new AlreadyLive({ runId: error.liveRunId, subject })
          : new DispatchFailed({
              cause: error,
              detail: describeFailure(error).errorMessage,
              subject,
            })
      );
    })
  );
