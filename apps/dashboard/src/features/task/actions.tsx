import {
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
import { failureText } from "@/lib/failure";

/** How often a pending intent is re-read while waiting for the orchestrator to answer it. */
const REFUSAL_POLL_MS = 3000;

/**
 * What can be done to a task from its own page besides setting its fields:
 * what to do with the run on it. Where the task sits is a property now, edited
 * in the property rows like everything else, and verbs and values keep to their
 * own rows.
 *
 * Stop and rerun steer a container and are refused by the orchestrator rather
 * than by the board, so they stay buttons and stay chosen by whether there is
 * a run to steer; a button whose only outcome is a rejection teaches a person
 * nothing. Commenting is not here: the Comments tab carries its own count and
 * its own box, and a button that only scrolls to another button is furniture.
 *
 * With nothing to steer the row disappears rather than holding a gap open — a
 * task in the backlog has no run, and most of them never grow one.
 */
export const TaskActions = ({ detail }: { readonly detail: TaskDetail }) => {
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

  const canStop = liveRunId !== null;
  const canRerun =
    (inProgress && liveRunId === null) ||
    task.status === "review" ||
    task.status === "done";

  if (!(canStop || canRerun) && failed === null) {
    return <LastRefusal taskId={task.id} />;
  }

  return (
    <div className="flex flex-col gap-2">
      <div className="flex flex-wrap items-center gap-2">
        {canStop ? (
          <Button
            disabled={busy}
            onClick={stopRun}
            size="sm"
            variant="destructive"
          >
            <HugeiconsIcon icon={StopIcon} strokeWidth={2} />
            Stop
          </Button>
        ) : null}
        {canRerun ? (
          <Button
            disabled={busy}
            onClick={rerunTask}
            size="sm"
            variant="outline"
          >
            <HugeiconsIcon icon={ReloadIcon} strokeWidth={2} />
            Rerun
          </Button>
        ) : null}
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
