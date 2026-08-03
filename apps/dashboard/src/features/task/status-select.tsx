import type { Task } from "@workspace/api";
import { TASK_STATUSES, type TaskStatus } from "@workspace/domain";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@workspace/ui/components/select";
import { useCallback, useMemo } from "react";
import { useTransitionTask } from "@/api/tasks";
import { STATUS_LABELS } from "@/features/task/task-fields";
import { failureText } from "@/lib/failure";

interface StatusSelectProps {
  /** Whether something else on the page is already writing to this task. */
  readonly busy?: boolean;
  readonly task: Task;
}

/**
 * Where the task sits, as the control that changes it.
 *
 * Every column is in the list and any of them can be picked from any other — the
 * board's own rule, and the reason this replaced the row of verbs that used to
 * be here. "Start", "Review" and "Approve" were three buttons that appeared and
 * disappeared by status and between them could only walk a card forwards; a card
 * filed in the wrong column had to be dragged back on the board, and one filed
 * in `ideas` that turned out to be finished could not get to `done` at all.
 *
 * Two things follow from picking a status here rather than pressing a verb:
 * choosing *In progress* dispatches a run, exactly as dropping the card in that
 * column does, and choosing anything else while a run is live asks that run to
 * stop. Neither is confirmed, because the selection is the instruction.
 *
 * Picking the status the task is already in sends nothing. The gateway would
 * refuse it — a transition changes the status, by definition — and a request
 * whose only possible answer is a refusal is not worth a round trip.
 */
export const StatusSelect = ({ busy = false, task }: StatusSelectProps) => {
  const transition = useTransitionTask();
  const { mutate } = transition;

  const items = useMemo(
    () =>
      TASK_STATUSES.map((status) => ({
        label: STATUS_LABELS[status],
        value: status,
      })),
    []
  );

  const onValueChange = useCallback(
    (next: TaskStatus | null) => {
      if (next === null || next === task.status) {
        return;
      }
      mutate({ taskId: task.id, to: next });
    },
    [mutate, task.id, task.status]
  );

  const failed = failureText(transition.error);

  return (
    <div className="flex items-center gap-2">
      <Select items={items} onValueChange={onValueChange} value={task.status}>
        <SelectTrigger
          aria-label="Task status"
          className="w-40"
          disabled={busy || transition.isPending}
        >
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          {items.map((item) => (
            <SelectItem key={item.value} value={item.value}>
              {item.label}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
      {failed === null ? null : (
        <p className="text-destructive text-xs">{failed}</p>
      )}
    </div>
  );
};
