import {
  Comment01Icon,
  InformationCircleIcon,
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
import { StatusSelect } from "@/features/task/status-select";
import { failureText } from "@/lib/failure";

/** How often a pending intent is re-read while waiting for the orchestrator to answer it. */
const REFUSAL_POLL_MS = 3000;

interface TaskActionsProps {
  readonly detail: TaskDetail;
  /** Takes the reader to the conversation, which is where commenting happens. */
  readonly onComment?: () => void;
}

/**
 * What can be done to a task from its own page: where it sits, what to do with
 * the run on it, and saying something.
 *
 * The column is a selector rather than a row of verbs. "Start", "Review" and
 * "Approve" were the same write dressed as three buttons that came and went with
 * the status, and between them they could only ever walk a card forwards — so
 * the one move an operator actually needed, putting a card back where it
 * belonged, was not here at all. A field showing where the task is, which can be
 * set to anywhere else, is the whole of it.
 *
 * What is left beside it is not about the column. Stop and rerun steer a
 * container and are refused by the orchestrator rather than by the board, so
 * they stay buttons and stay chosen by whether there is a run to steer; a button
 * whose only outcome is a rejection teaches a person nothing. Commenting is
 * always available: it is the one thing that is true of a task in every column.
 */
export const TaskActions = ({ detail, onComment }: TaskActionsProps) => {
  const { liveRunId, task } = detail;
  const stop = useStopRun();
  const rerun = useRerunTask();
  const { mutate: askStop } = stop;
  const { mutate: askRerun } = rerun;

  const stopRun = useCallback(
    () => askStop({ taskId: task.id }),
    [askStop, task.id]
  );
  const rerunTask = useCallback(
    () => askRerun({ taskId: task.id }),
    [askRerun, task.id]
  );

  const busy = stop.isPending || rerun.isPending;
  const inProgress = task.status === "in_progress";
  const failed = failureText(stop.error ?? rerun.error);

  return (
    <div className="flex flex-col gap-2">
      <div className="flex flex-wrap items-center gap-2">
        <StatusSelect busy={busy} task={task} />
        {liveRunId === null ? null : (
          <Button disabled={busy} onClick={stopRun} variant="destructive">
            <HugeiconsIcon icon={StopIcon} strokeWidth={2} />
            Stop
          </Button>
        )}
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
