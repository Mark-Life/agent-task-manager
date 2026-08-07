/**
 * What a run event means for a person, read back off the rows.
 *
 * The channel carries ids and a kind, never a payload, so every wake-up asks
 * the database what actually happened. That is what makes a duplicate notice
 * free and a dropped one recoverable — and it is also the only way to tell the
 * three notices apart, because the difference between "the run finished" and
 * "this needs your eyes" is not on the run at all. It is the column the task
 * ended up in.
 *
 * **Closing a run is several writes, and the notice can beat them.** The
 * terminal event is appended by the ingest, and the run row's outcome and the
 * task's move into `review` are written after it. A notice that read the rows
 * the instant it was woken would announce a finished run as still running and
 * would never see the review. So the read settles — see `../settle`, which is
 * the same wait the manager's answer is read behind. The window is bounded and
 * the notices are handled concurrently, so the cost of it is latency nobody is
 * watching.
 *
 * What comes back is a value the renderer can turn into a message and nothing
 * more — no tool calls, no transcript, no argv. A person is told what the run
 * was for, how it ended, what it cost and where to look.
 */

import { RunRepo, TaskRepo } from "@workspace/db";
import type {
  Run,
  RunEventKind,
  RunId,
  RunNotifyKind,
  Task,
  TaskId,
  WorkspaceId,
} from "@workspace/domain";
import { costUsdToNumber, isRunLive } from "@workspace/domain";
import { clipError } from "@workspace/telemetry";
import { Effect } from "effect";
import { settledRun } from "../settle";
import type { RunNotice } from "./render";

/**
 * How long a notice waits for the close-out to land.
 *
 * Long enough for the writes that follow a terminal event, short enough that
 * nobody notices. A run somehow still live at the end of it is described from
 * the event that woke us.
 */
export const NOTICE_SETTLE_MS = 2000;

/** The kinds of run event that are worth telling somebody about. */
export const TERMINAL_EVENT_KINDS: readonly RunEventKind[] = [
  "failed",
  "finished",
  "stopped",
];

/** What a notice is about, before anything has been read. */
export interface NoticeRequest {
  /** The run event that woke us, where one did. */
  readonly eventKind?: RunEventKind | null;
  /** Already decided, when a claim is being re-sent rather than made. */
  readonly kind?: RunNotifyKind | null;
  readonly runId: RunId | null;
  readonly taskId: TaskId;
  readonly workspaceId: WorkspaceId;
}

/** A notice with everything a message about it needs. */
export interface DescribedNotice {
  readonly kind: RunNotifyKind;
  readonly notice: RunNotice;
  readonly run: Run | null;
  readonly task: Task;
}

/**
 * Which of the three this is, or null when it is none of them.
 *
 * Read as a table. A clean ending on a task that has moved into `review` is
 * the review request — that is the whole handover, and announcing it as
 * "finished" would bury the one notice somebody has to act on. A clean ending
 * anywhere else is the finish. Everything else that ended is the failure,
 * including a stop, because a run somebody killed did not do the work either.
 * A run still live after the settle is nothing to say yet.
 */
export const notifyKindOf = (options: {
  readonly eventKind: RunEventKind | null;
  readonly run: Run | null;
  readonly task: Task;
}): RunNotifyKind | null => {
  const { eventKind, run, task } = options;
  const ended = run !== null && !isRunLive(run) ? run.outcome : null;
  const clean =
    ended === "done" || (ended === null && eventKind === "finished");
  if (clean) {
    return task.status === "review" ? "needs_review" : "run_finished";
  }
  if (ended !== null || eventKind === "failed" || eventKind === "stopped") {
    return "run_failed";
  }
  return null;
};

/**
 * Everything a notice about this task needs, or null when there is nothing to
 * say.
 *
 * The task is read after the run so that a task moved into `review` by the
 * close-out is seen as reviewable rather than as in progress.
 */
export const describeNotice = Effect.fn("Notify.describeNotice")(function* (
  request: NoticeRequest
) {
  const { runId, taskId, workspaceId } = request;
  yield* Effect.annotateCurrentSpan({ runId, taskId, workspaceId });

  const runs = yield* RunRepo;
  const tasks = yield* TaskRepo;

  const run =
    runId === null
      ? null
      : yield* settledRun({
          runId,
          runs,
          windowMs: NOTICE_SETTLE_MS,
          workspaceId,
        });
  const task = yield* tasks.byId({ id: taskId, workspaceId });

  const kind =
    request.kind ??
    notifyKindOf({ eventKind: request.eventKind ?? null, run, task });
  if (kind === null) {
    return null;
  }

  return {
    kind,
    notice: {
      // The store keeps a cost as a decimal string so no arithmetic rounds it;
      // a message is the display it is allowed to become a float for.
      costUsd:
        run === null || run.costUsd === null
          ? null
          : costUsdToNumber(run.costUsd),
      durationMs: run?.durationMs ?? null,
      errorMessage:
        run?.errorMessage === null || run?.errorMessage === undefined
          ? null
          : clipError(run.errorMessage),
      hasLiveRun: run !== null && isRunLive(run),
      kind,
      // Held for the line the run's own last words belong on. Nothing fills it
      // yet: `run_event` is only readable oldest-first, so finding the last
      // assistant message means paging a whole timeline per notification.
      lastMessage: null,
      outcome: run?.outcome ?? null,
      taskId: task.id,
      taskStatus: task.status,
      taskTitle: task.title,
      totalTokens: run?.totalTokens ?? null,
      turns: run?.turns ?? null,
    },
    run,
    task,
  } satisfies DescribedNotice;
});
