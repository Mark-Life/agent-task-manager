import {
  CheckmarkCircle01Icon,
  Comment01Icon,
  InformationCircleIcon,
  PlayIcon,
  ReloadIcon,
  StopIcon,
} from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { useQuery } from "@tanstack/react-query";
import type { TaskDetail } from "@workspace/api";
import type { TaskId } from "@workspace/domain";
import { Button } from "@workspace/ui/components/button";
import { useCallback } from "react";
import {
  commandsQuery,
  isPending,
  refusalOf,
  useRerunTask,
  useStopRun,
} from "@/api/run-commands";
import { useTransitionTask } from "@/api/tasks";

/** How often a pending intent is re-read while waiting for the orchestrator to answer it. */
const REFUSAL_POLL_MS = 3000;

/**
 * What a failed request means, in the reader's terms.
 *
 * Every failure the contract declares carries a tag, and the tag is the only
 * part of it a person can act on — the rest names rows and actors. Anything
 * unlisted is a transport fault or a defect, which reads the same to whoever is
 * looking at the screen: it did not go through.
 */
const FAILURE_TEXT: Record<string, string> = {
  AgentSessionEnded: "That session has already ended.",
  ArtifactAlreadyPromoted: "That file has already been promoted.",
  Forbidden: "You do not have permission for that.",
  IllegalTransition: "That move is not one this task can make from here.",
  InvalidInput: "The server refused the contents.",
  NotFound: "That no longer exists.",
  PayloadTooLarge: "That file is over the size this endpoint accepts.",
  RunAlreadyLive: "A run is already working on this task.",
  RunNotLive: "That run has already ended.",
};

/**
 * A sentence for a failure, or null when there was none. Callers render the
 * null as nothing; the tagged union survives all the way from the endpoint, so
 * the branch here is on a value rather than on a parsed message.
 */
export const failureText = (
  error: { readonly _tag: string } | null | undefined
) => {
  if (error === null || error === undefined) {
    return null;
  }
  return FAILURE_TEXT[error._tag] ?? "That did not go through.";
};

interface TaskActionsProps {
  readonly detail: TaskDetail;
  /** Takes the reader to the conversation, which is where commenting happens. */
  readonly onComment?: () => void;
}

/**
 * The verbs a task offers, which are exactly the ones the Telegram bot offers
 * for the same status.
 *
 * A button whose only outcome is the gateway's rejection teaches a person
 * nothing except that the screen does not know what it is showing them, so the
 * set is chosen from the status and whether a run is live rather than shown in
 * full and disabled. Commenting is always available: it is the one thing that
 * is true of a task in every column.
 */
export const TaskActions = ({ detail, onComment }: TaskActionsProps) => {
  const { liveRunId, task } = detail;
  const transition = useTransitionTask();
  const stop = useStopRun();
  const rerun = useRerunTask();
  const { mutate: move } = transition;
  const { mutate: askStop } = stop;
  const { mutate: askRerun } = rerun;

  const start = useCallback(
    () => move({ taskId: task.id, to: "in_progress" }),
    [move, task.id]
  );
  const review = useCallback(
    () => move({ taskId: task.id, to: "review" }),
    [move, task.id]
  );
  const approve = useCallback(
    () => move({ taskId: task.id, to: "done" }),
    [move, task.id]
  );
  const stopRun = useCallback(
    () => askStop({ taskId: task.id }),
    [askStop, task.id]
  );
  const rerunTask = useCallback(
    () => askRerun({ taskId: task.id }),
    [askRerun, task.id]
  );

  const busy = transition.isPending || stop.isPending || rerun.isPending;
  const inProgress = task.status === "in_progress";
  const filed = task.status === "ideas" || task.status === "backlog";
  const failed = failureText(transition.error ?? stop.error ?? rerun.error);

  return (
    <div className="flex flex-col gap-2">
      <div className="flex flex-wrap items-center gap-2">
        {filed ? (
          <Button disabled={busy} onClick={start}>
            <HugeiconsIcon icon={PlayIcon} strokeWidth={2} />
            Start
          </Button>
        ) : null}
        {inProgress && liveRunId !== null ? (
          <Button disabled={busy} onClick={stopRun} variant="destructive">
            <HugeiconsIcon icon={StopIcon} strokeWidth={2} />
            Stop
          </Button>
        ) : null}
        {inProgress ? (
          <Button disabled={busy} onClick={review} variant="secondary">
            <HugeiconsIcon icon={CheckmarkCircle01Icon} strokeWidth={2} />
            Review
          </Button>
        ) : null}
        {task.status === "review" ? (
          <Button disabled={busy} onClick={approve}>
            <HugeiconsIcon icon={CheckmarkCircle01Icon} strokeWidth={2} />
            Approve
          </Button>
        ) : null}
        {(inProgress && liveRunId === null) ||
        task.status === "review" ||
        task.status === "done" ? (
          <Button disabled={busy} onClick={rerunTask} variant="outline">
            <HugeiconsIcon icon={ReloadIcon} strokeWidth={2} />
            Rerun
          </Button>
        ) : null}
        <Button onClick={onComment} variant="ghost">
          <HugeiconsIcon icon={Comment01Icon} strokeWidth={2} />
          Comment
        </Button>
      </div>
      {failed === null ? null : (
        <p className="text-destructive text-xs">{failed}</p>
      )}
      <LastRefusal taskId={task.id} />
    </div>
  );
};

/**
 * Why the orchestrator declined the last thing that was asked of this task.
 *
 * A refusal is not a failed request — the row is written, answered with 200 and
 * rejected a moment later, so nothing about it arrives at the button that
 * caused it. It is read back off the command list instead, polled only while
 * something is still waiting to be claimed, and shown as information rather
 * than as an alarm.
 */
const LastRefusal = ({ taskId }: { readonly taskId: TaskId }) => {
  const commands = useQuery({
    ...commandsQuery(taskId),
    refetchInterval: (query) =>
      query.state.data?.some(isPending) === true ? REFUSAL_POLL_MS : false,
  });

  const latest = commands.data?.[0];
  const reason = latest === undefined ? null : refusalOf(latest);
  if (reason === null) {
    return null;
  }

  return (
    <p className="flex items-center gap-1.5 text-muted-foreground text-xs">
      <HugeiconsIcon
        className="size-3.5 shrink-0"
        icon={InformationCircleIcon}
        strokeWidth={2}
      />
      The last request was not acted on: {reason}
    </p>
  );
};
