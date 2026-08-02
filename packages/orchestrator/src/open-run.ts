/**
 * Turning a claimed task into a run: which session it continues, which attempt
 * it is, and everything the later stages read off one immutable record.
 *
 * Nothing here touches a disk and nothing here decides *whether* to run a task
 * — the dispatcher has already decided that. What is left is the set of
 * questions a run cannot be started without an answer to, asked once so no
 * later stage asks them again and gets a different answer.
 */

import { AgentSessionRepo, RunRepo, TaskRepo, withActor } from "@workspace/db";
import {
  Actor,
  isResumable,
  nextSessionOf,
  type Project,
  type RunTrigger,
  type SessionProvider,
  type Task,
} from "@workspace/domain";
import { hostRunLayout } from "@workspace/harness";
import { sandboxImageFor } from "@workspace/sandbox";
import { Effect } from "effect";
import type { DispatchContext, ResolvedSession } from "./dispatch-context";
import { AlreadyLive, DispatchFailed, describeFailure } from "./errors";

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
  /** 1-based. The retry ladder and the park decision both count from here. */
  readonly attempt: number;
  readonly dataRoot: string;
  /** Used when no resumable session names one of its own. */
  readonly defaultProvider: SessionProvider;
  /** Which loop is acting, as the audit log records it. */
  readonly loopInstance: string;
  /** Null for a task that belongs to no project — ordinary, not missing. */
  readonly project: Project | null;
  /** How long the task waited between entering *in progress* and this claim. */
  readonly queueWaitMs: number;
  /** The claim span, captured at the top so an `onExit` emit still has it. */
  readonly spanId: string | null;
  readonly task: Task;
  readonly traceId: string | null;
  /** W3C `traceparent` for the container, so the turns inside it join this trace. */
  readonly traceparent: string | null;
  readonly trigger: RunTrigger;
}

/**
 * Opens the session, claims the attempt, and answers with the context every
 * later stage reads.
 *
 * The session comes first and the run row names it, which is the order the
 * domain requires — a process that dies in between leaves a running session
 * with no runs, a state the reconcile already knows how to close, whereas a run
 * with no session is a row that cannot be resumed or attributed.
 *
 * Which session runs is the task's own property rather than an argument, so a
 * dropdown in the dashboard and a sentence to the manager end up writing one
 * value and this reads it. A pinned session that has since failed degrades to a
 * fresh one instead of refusing the dispatch: the selection is a preference,
 * and a task that cannot start is a worse answer than a task that starts clean.
 */
const claimRun = Effect.fn("Run.open")(function* (claim: RunClaim) {
  const sessions = yield* AgentSessionRepo;
  const runs = yield* RunRepo;
  const tasks = yield* TaskRepo;

  const { task } = claim;
  const { id: taskId, workspaceId } = task;
  const asActor = withActor(
    Actor.cases.orchestrator.make({ loopInstance: claim.loopInstance })
  );

  yield* Effect.annotateCurrentSpan({ attempt: claim.attempt, taskId });

  const selection = nextSessionOf(task);
  // A pinned session is read by id; `latest` asks the repository, which already
  // excludes the failed ones. `new` asks nothing — it is the one selection that
  // is an instruction rather than a lookup. A pin whose session has been
  // deleted degrades to a fresh one rather than failing the dispatch.
  const lookup = () => {
    if (selection.mode === "specific") {
      return asActor(
        sessions.byId({ id: selection.sessionId, workspaceId })
      ).pipe(Effect.catchTag("Db.NotFound", () => Effect.succeed(null)));
    }
    if (selection.mode === "latest") {
      return asActor(sessions.latestResumable({ taskId, workspaceId }));
    }
    return Effect.succeed(null);
  };

  const found = yield* lookup();
  const resumable = found !== null && isResumable(found) ? found : null;
  const provider = resumable?.provider ?? claim.defaultProvider;
  const session =
    resumable ??
    (yield* asActor(sessions.open({ provider, taskId, workspaceId })));

  // A resumed session with no provider id has a row and no conversation behind
  // it — a session opened by a run that died before the harness answered. It is
  // resumed in every other sense and started fresh in the only one that counts.
  const resolved: ResolvedSession =
    resumable !== null && resumable.providerSessionId !== null
      ? {
          mode: "resumed",
          providerSessionId: resumable.providerSessionId,
          selected: selection.mode,
          session: resumable,
        }
      : { mode: "fresh", selected: selection.mode, session };

  // A selection is spent by the run that chose it, and the row that comes back
  // is the one every later stage reads: a context carrying the pre-clear task
  // would report a pin this run has already consumed. Skipped where the task
  // already sits on the default — an UPDATE that changes nothing still costs an
  // audit row, and a trail full of no-op rows is a trail nobody reads.
  const claimed =
    task.nextSessionId !== null || task.nextSessionNew
      ? yield* asActor(tasks.clearNextSession({ id: taskId, workspaceId }))
      : task;

  const run = yield* asActor(
    runs.create({
      agentSessionId: session.id,
      attempt: claim.attempt,
      provider,
      taskId,
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
    attempt: run.attempt,
    image: sandboxImageFor(task.sandboxImage),
    layout: hostRunLayout({ dataRoot: claim.dataRoot, runId: run.id }),
    project: claim.project,
    provider,
    queueWaitMs: claim.queueWaitMs,
    // The task's override, else the project's, else no repo at all — which is a
    // scratch directory and the whole difference between a coding task and a
    // personal one at this layer.
    repoUrl: task.repoUrl ?? claim.project?.repoUrl ?? null,
    runId: run.id,
    session: resolved,
    spanId: claim.spanId,
    task: claimed,
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
    Effect.catch((error) =>
      Effect.fail(
        error._tag === "RunRepo.AlreadyLive"
          ? new AlreadyLive({
              runId: error.liveRunId,
              taskId: claim.task.id,
            })
          : new DispatchFailed({
              cause: error,
              detail: describeFailure(error).errorMessage,
              taskId: claim.task.id,
            })
      )
    )
  );
