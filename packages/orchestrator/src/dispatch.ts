/**
 * What runs next, and everything that has to be true before it can.
 *
 * This is the front half of the loop and it stops one step short of writing
 * anything: it reads the *in progress* column and the threads with something
 * unanswered, decides what is eligible, and hands back the {@link RunClaim}
 * that `./open-run` turns into rows. Opening the session and the run belongs
 * there, and keeping the split at that line is what stops two files deciding
 * which session a `latest` selection resolves to.
 *
 * **Both queues are in Postgres.** A board column read by rank, and a query for
 * threads holding a user message their newest session has not been shown. A
 * queue held in a process is dropped when the process restarts, which is
 * exactly what the chat path used to do.
 *
 * Three rules decide eligibility, and each exists because of a specific
 * failure.
 *
 * **Rank, ascending.** The board reads a column by rank and so does this, so
 * dragging a card to the top of *in progress* and telling the manager agent to
 * run something next are the same write. There is no priority field and no
 * second ordering here: the repository returns the column already ordered, and
 * a comparator of our own would be the second derivation that eventually
 * disagrees with the board a human is looking at.
 *
 * **Not parked.** A task whose dispatch failed its way through the retry ladder
 * carries a `parkedUntil` in the future. Skipping it is what stops one broken
 * task from spending every slot on the box; any human move back into *in
 * progress* clears the stamp, which is the un-park.
 *
 * **No live run.** One run per task at a time, because two containers on one
 * task means two writers on one artifacts directory. It is checked twice on
 * purpose: once here as a read, so the sweep skips cheaply and can say why, and
 * once inside `RunRepo.create`, which locks the task row and refuses — that
 * second one is the real guarantee, since a notify and a poll can arrive
 * together.
 *
 * A plan reads rows and writes none. That is what lets the quota gate ask about
 * a task the loop has not committed to yet: a provider with no allowance left
 * should cost a skipped sweep, never a run row that has to be closed as failed
 * and a task that has to be moved out of the column to say so.
 */

import {
  AgentSessionRepo,
  ChatMessageRepo,
  ChatThreadRepo,
  CurrentActor,
  ProjectRepo,
  RunRepo,
  TaskRepo,
} from "@workspace/db";
import {
  type Actor,
  ChatMessageId,
  type ChatThread,
  nextSessionOf,
  type Project,
  type Run,
  type RunSubject,
  type RunTrigger,
  type SessionProvider,
  type Task,
  type TaskId,
  type Timestamp,
  traceparentOf,
  type WorkspaceId,
} from "@workspace/domain";
import { currentTraceIds } from "@workspace/telemetry";
import { Context, DateTime, Effect, Layer, Schema } from "effect";
import { orchestratorConfig } from "./config";
import { DispatchFailed, describeFailure } from "./errors";
import type { RunClaim } from "./open-run";
import { watermarkOf } from "./prompt";
import {
  managerAttachment,
  type RunAttachment,
  subjectOfAttachment,
  workerAttachment,
} from "./subject";

/**
 * Why a task in the column was passed over. Each is an ordinary state of a
 * healthy board rather than a fault, which is why they are a value on the
 * decision and not an error: a sweep that skipped everything is a sweep with
 * nothing to do, and an operator asking "why is this card not moving" wants the
 * three answers spelled apart.
 */
export const SKIP_REASONS = [
  "live_run",
  "not_in_progress",
  "nothing_unread",
  "parked",
] as const;

/** Which rule held a task back. */
export const SkipReason = Schema.Literals(SKIP_REASONS);
export type SkipReason = typeof SkipReason.Type;

/** The task is eligible, and everything a run needs to be opened is resolved. */
export interface Planned {
  readonly claim: RunClaim;
  readonly kind: "ready";
  /**
   * The harness this run will most likely take, for the quota gate to ask
   * about. A prediction rather than the decision: `./open-run` resolves the
   * session and owns the answer, and the two differ only where a session was
   * deleted between this read and that write.
   */
  readonly provider: SessionProvider;
}

/** The work was passed over, and nothing was written. */
export interface Skipped {
  readonly kind: "skipped";
  readonly reason: SkipReason;
  readonly subject: RunSubject;
}

/**
 * What one look at a task produced. A union rather than a nullable claim
 * because the skip carries its reason, and the reason is the field the sweep
 * logs and the board eventually renders.
 */
export type DispatchDecision = Planned | Skipped;

/** The trigger a task entering *in progress* dispatches under. */
const DEFAULT_TRIGGER: RunTrigger = "status_change";

/** The first attempt at a task, before anything has failed. */
const FIRST_ATTEMPT = 1;

/**
 * The outcomes that end a losing streak. A run somebody stopped is not evidence
 * that the task is broken, and a clean finish plainly is not, so both put the
 * retry ladder back on its first rung — otherwise a task that has run happily
 * ten times would be one bad night away from being parked on its next failure.
 */
const RESETS_ATTEMPTS: readonly Run["outcome"][] = ["done", "interrupted"];

/**
 * Whether the dispatcher must leave this task alone for now. Parking is a
 * stamp with an expiry rather than a status, so the answer is a comparison and
 * not a column read: the retry ladder writes the instant the next attempt is
 * allowed, and a loop restarting mid-backoff resumes it by reading this.
 */
export const isParked = (input: {
  readonly now: Timestamp;
  readonly task: Pick<Task, "parkedUntil">;
}) =>
  input.task.parkedUntil !== null &&
  DateTime.toEpochMillis(input.task.parkedUntil) >
    DateTime.toEpochMillis(input.now);

/**
 * Which attempt the next run on this task is, from its history newest first.
 *
 * It counts the unbroken run of failures at the head rather than the runs on
 * the task, because the number feeds the backoff ladder and the park threshold
 * — both of which are asking "how badly is this going right now", not "how much
 * work has this task ever had". A `done` or `interrupted` run stops the count,
 * and so does a live one, which the caller has already ruled out.
 */
export const attemptAfter = (history: readonly Pick<Run, "outcome">[]) => {
  let failures = 0;
  for (const run of history) {
    if (run.outcome === null || RESETS_ATTEMPTS.includes(run.outcome)) {
      break;
    }
    failures += 1;
  }
  return failures + FIRST_ATTEMPT;
};

/**
 * How long the task waited between entering *in progress* and being claimed.
 * Clamped at zero: clock skew between the database and this process is real,
 * and a negative queue wait is a number somebody would later average.
 */
const queueWaitOf = (input: {
  readonly claimedAt: Timestamp;
  readonly statusChangedAt: Timestamp;
}) =>
  Math.max(
    0,
    DateTime.toEpochMillis(input.claimedAt) -
      DateTime.toEpochMillis(input.statusChangedAt)
  );

/** What identifies the task a plan is about. */
interface TaskRef {
  readonly id: TaskId;
  readonly workspaceId: WorkspaceId;
}

/** What planning one piece of work needs. The row is passed whole; it was just read. */
export interface PlanInput {
  /** The task or the conversation, and therefore which role the run will be. */
  readonly attached: RunAttachment;
  /** Why this run exists. A card entering the column is a status change. */
  readonly trigger?: RunTrigger;
}

/** What reading the head of the column needs. */
export interface QueueInput {
  /** How many free slots the pool has. Nothing beyond that is worth checking. */
  readonly limit: number;
  readonly workspaceId: WorkspaceId;
}

const skipped = (attached: RunAttachment, reason: SkipReason): Skipped => ({
  kind: "skipped",
  reason,
  subject: subjectOfAttachment(attached),
});

/**
 * The loop this plan is made by, as the audit log will name it. Any other
 * ambient actor — a script driving a plan by hand — still opens its run as the
 * orchestrator, so the name it lends is the one thing worth taking from it.
 */
const loopInstanceOf = (actor: Actor) =>
  actor.kind === "orchestrator" ? actor.loopInstance : actor.kind;

const make = Effect.gen(function* () {
  const config = yield* orchestratorConfig;
  const messages = yield* ChatMessageRepo;
  const projects = yield* ProjectRepo;
  const runs = yield* RunRepo;
  const sessions = yield* AgentSessionRepo;
  const tasks = yield* TaskRepo;
  const threads = yield* ChatThreadRepo;

  /**
   * Which harness this run will most likely take.
   *
   * A read of the same rows `./open-run` resolves the session from, and
   * deliberately not the resolution itself: this answer is wanted *before* a
   * row exists, because the quota gate decides whether to spend a slot at all
   * and a deferral has to cost nothing. Where the two differ — a pinned session
   * deleted between this read and that write — the run's own resolution wins
   * and the row records what actually ran.
   */
  const providerFor = (attached: RunAttachment) =>
    Effect.gen(function* () {
      const subject = subjectOfAttachment(attached);
      const workspaceId =
        attached.role === "worker"
          ? attached.task.workspaceId
          : attached.thread.workspaceId;
      // A conversation names its own provider and has no selection column; a
      // task's selection is the one thing that can point somewhere else.
      const fallback =
        attached.role === "manager"
          ? attached.thread.provider
          : config.defaultProvider;
      const selection =
        attached.role === "worker"
          ? nextSessionOf(attached.task)
          : ({ mode: "latest" } as const);

      if (selection.mode === "new") {
        return fallback;
      }
      if (selection.mode === "specific") {
        const pinned = yield* sessions
          .byId({ id: selection.sessionId, workspaceId })
          .pipe(Effect.catchTag("Db.NotFound", () => Effect.succeed(null)));
        return pinned?.provider ?? fallback;
      }
      const latest = yield* sessions.latestResumable({ subject, workspaceId });
      return latest?.provider ?? fallback;
    });

  /** The claim shared by both roles, once the role-specific reads have passed. */
  const claimFor = Effect.fnUntraced(function* (input: {
    readonly attached: RunAttachment;
    readonly attempt: number;
    readonly project: Project | null;
    readonly queueWaitMs: number;
    readonly trigger: RunTrigger;
  }) {
    // Read while the plan's span is open and carried on the claim: the wide
    // event is emitted as that span closes, and by then `Effect.currentSpan`
    // answers nothing.
    //
    // These are the request's ids wherever the row that asked for this run
    // carried a `traceparent` — the caller's span is adopted as this fiber's
    // parent before planning starts, so the run row, the header handed to the
    // container and the wide event all name the trace that asked, without any
    // of them knowing where the trace came from.
    const ids = yield* currentTraceIds;
    return {
      attached: input.attached,
      attempt: input.attempt,
      dataRoot: config.dataRoot,
      defaultProvider: config.defaultProvider,
      loopInstance: loopInstanceOf(yield* CurrentActor),
      project: input.project,
      queueWaitMs: input.queueWaitMs,
      spanId: ids.spanId,
      traceId: ids.traceId,
      traceparent: traceparentOf(ids),
      trigger: input.trigger,
    } satisfies RunClaim;
  });

  /** Everything a task's plan reads, before failures are given a name. */
  const resolveTask = Effect.fnUntraced(function* (input: {
    readonly task: Task;
    readonly trigger: RunTrigger;
  }) {
    const { task, trigger } = input;
    const attached = workerAttachment(task);
    const ref: TaskRef = { id: task.id, workspaceId: task.workspaceId };
    const claimedAt = yield* DateTime.now;

    // Re-checked against the row in hand rather than trusted from the sweep:
    // between the read and here a stop command may have moved the card, and
    // spending a slot on a task that has left the column is the one mistake
    // this gate exists to prevent.
    if (task.status !== "in_progress") {
      return skipped(attached, "not_in_progress");
    }
    if (isParked({ now: claimedAt, task })) {
      return skipped(attached, "parked");
    }
    const live = yield* runs.liveForTask({
      taskId: ref.id,
      workspaceId: ref.workspaceId,
    });
    if (live !== null) {
      return skipped(attached, "live_run");
    }

    const project =
      task.projectId === null
        ? null
        : yield* projects.byId({
            id: task.projectId,
            workspaceId: ref.workspaceId,
          });

    const history = yield* runs.listByTask({
      taskId: ref.id,
      workspaceId: ref.workspaceId,
    });

    return {
      claim: yield* claimFor({
        attached,
        attempt: attemptAfter(history),
        project,
        queueWaitMs: queueWaitOf({
          claimedAt,
          statusChangedAt: task.statusChangedAt,
        }),
        trigger,
      }),
      kind: "ready",
      provider: yield* providerFor(attached),
    } satisfies Planned;
  });

  /**
   * Everything a conversation's plan reads.
   *
   * The unread re-check is the chat half of the task's status re-check: a turn
   * may have started and finished between the queue read and here, and starting
   * a container with nothing to answer is the same wasted slot.
   *
   * The wait is measured from the *oldest* unread message rather than the
   * newest, because that is the one the person has actually been waiting on —
   * several that arrived while a turn ran are one prompt, and the number worth
   * reporting is how long the first of them sat there.
   */
  const resolveThread = Effect.fnUntraced(function* (input: {
    readonly thread: ChatThread;
    readonly trigger: RunTrigger;
  }) {
    const { thread, trigger } = input;
    const attached = managerAttachment(thread);
    const ref = { id: thread.id, workspaceId: thread.workspaceId };
    const claimedAt = yield* DateTime.now;

    const live = yield* runs.liveForThread({
      threadId: thread.id,
      workspaceId: thread.workspaceId,
    });
    if (live !== null) {
      return skipped(attached, "live_run");
    }

    const session = yield* sessions.latestResumable({
      subject: subjectOfAttachment(attached),
      workspaceId: thread.workspaceId,
    });
    const watermark = session === null ? null : watermarkOf(session);
    const unread = yield* messages.since({
      threadId: thread.id,
      // The column holds a chat message's id on a thread's session; the brand
      // is put back here, where the row it points at is being read.
      watermark:
        watermark === null
          ? null
          : {
              createdAt: watermark.createdAt,
              id: ChatMessageId.make(watermark.id),
            },
      workspaceId: thread.workspaceId,
    });
    const [oldest] = unread;
    if (oldest === undefined) {
      return skipped(attached, "nothing_unread");
    }

    const history = yield* runs.listByThread({
      threadId: ref.id,
      workspaceId: ref.workspaceId,
    });

    return {
      claim: yield* claimFor({
        attached,
        attempt: attemptAfter(history),
        project: null,
        queueWaitMs: queueWaitOf({
          claimedAt,
          statusChangedAt: oldest.createdAt,
        }),
        trigger,
      }),
      kind: "ready",
      provider: yield* providerFor(attached),
    } satisfies Planned;
  });

  /** Every read a plan makes, before failures are given a name. */
  const resolve = (input: PlanInput) => {
    const trigger = input.trigger ?? DEFAULT_TRIGGER;
    return input.attached.role === "worker"
      ? resolveTask({ task: input.attached.task, trigger })
      : resolveThread({ thread: input.attached.thread, trigger });
  };

  /**
   * Everything that has to be true before a task can be run, resolved, with no
   * row written.
   *
   * The caller opens the run from the claim this hands back. Splitting it there
   * is what lets the quota gate, the lease and the pool all refuse in between
   * without anything to undo.
   */
  const plan = Effect.fn("Dispatch.plan")(function* (input: PlanInput) {
    const subject = subjectOfAttachment(input.attached);
    yield* Effect.annotateCurrentSpan({
      role: input.attached.role,
      subjectId: subject.id,
      subjectKind: subject.kind,
    });

    return yield* resolve(input).pipe(
      Effect.mapError(
        (cause) =>
          new DispatchFailed({
            cause,
            detail: describeFailure(cause).errorMessage,
            subject,
          })
      )
    );
  });

  /**
   * The head of the *in progress* column that is actually dispatchable, in the
   * order the board draws it.
   *
   * Bounded by the pool's free slots rather than returning the whole column,
   * because the liveness check is a query per candidate and a slot the pool
   * does not have is a question not worth asking. The loop stops at the first
   * `limit` eligible tasks and leaves the rest for the next sweep, which is
   * also what keeps a long column from turning one wake-up into a scan.
   */
  const queue = Effect.fn("Dispatch.queue")(function* (input: QueueInput) {
    yield* Effect.annotateCurrentSpan({ workspaceId: input.workspaceId });

    const column = yield* tasks.byStatus({
      status: "in_progress",
      workspaceId: input.workspaceId,
    });
    const now = yield* DateTime.now;
    const ready: Task[] = [];

    for (const task of column) {
      if (ready.length >= input.limit) {
        break;
      }
      if (isParked({ now, task })) {
        continue;
      }
      const live = yield* runs.liveForTask({
        taskId: task.id,
        workspaceId: input.workspaceId,
      });
      if (live === null) {
        ready.push(task);
      }
    }

    return ready as readonly Task[];
  });

  /**
   * The conversations with something to answer, oldest wait first.
   *
   * One query rather than a candidate loop, because the two things the loop
   * would check per row — an unread message and no live turn — are both in the
   * repository's own predicate. That is also what makes the chat queue durable:
   * a restart re-reads it, where the in-memory queue this replaced was simply
   * dropped.
   */
  const chatQueue = Effect.fn("Dispatch.chatQueue")(function* (
    input: QueueInput
  ) {
    yield* Effect.annotateCurrentSpan({ workspaceId: input.workspaceId });
    return yield* threads.awaitingReply({
      limit: input.limit,
      workspaceId: input.workspaceId,
    });
  });

  return { chatQueue, plan, queue } as const;
});

/**
 * The front of the loop: what is eligible, and the claim that turns one
 * eligible task into a resolved run. It writes rows and reads three tables, and
 * it deliberately knows nothing about containers.
 */
export class Dispatch extends Context.Service<
  Dispatch,
  Effect.Success<typeof make>
>()("@workspace/orchestrator/Dispatch") {
  static readonly layer = Layer.effect(Dispatch, make);
}
