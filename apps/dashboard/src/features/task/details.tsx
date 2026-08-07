import type { Task } from "@workspace/api";
import { Separator } from "@workspace/ui/components/separator";
import { TaskBrief } from "@/features/task/brief";
import { DeleteTask } from "@/features/task/delete-task";
import { TaskProperties } from "@/features/task/properties";

interface TaskDetailsProps {
  /** Called once the task is gone: the page leaves for the board, the overlay closes. */
  readonly onDeleted: () => void;
  readonly task: Task;
}

/**
 * What the task *is*, as one panel: the fields it sits under, then what it asks
 * for and what it will be judged by.
 *
 * These used to stand above the tab strip, which meant a reader scrolled past
 * a ten-line brief to reach the conversation every time they opened a task. As
 * a panel they cost one click to reach and nothing to ignore, and the header
 * above keeps the two facts that are worth seeing from any panel — the name and
 * the status.
 *
 * Deletion sits at the very foot, below a rule: the last thing in the panel a
 * reader visits on purpose, rather than a button beside the way out.
 */
export const TaskDetails = ({ onDeleted, task }: TaskDetailsProps) => (
  <div className="flex flex-col gap-5">
    <TaskProperties task={task} />
    <Separator />
    <TaskBrief task={task} />
    <Separator />
    <DeleteTask onDeleted={onDeleted} task={task} />
  </div>
);
