import { Delete02Icon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import type { Task } from "@workspace/api";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from "@workspace/ui/components/alert-dialog";
import { Button } from "@workspace/ui/components/button";
import { useCallback } from "react";
import { useDeleteTask } from "@/api/tasks";

interface DeleteTaskProps {
  /** Where to go once the task is gone — the page it was on no longer resolves. */
  readonly onDeleted?: () => void;
  readonly task: Task;
}

/**
 * Deletion, said in words at the foot of the details panel.
 *
 * Far from the close button on purpose, and labelled rather than a bare icon:
 * this is the one control on the task whose damage cannot be undone, so it is
 * reached deliberately and reads as what it is before it is pressed.
 *
 * The confirmation says what goes with the task — its messages, sessions, runs
 * and artifacts, the evidence of what happened, not just the card — rather than
 * asking "are you sure", which tells a reader nothing they did not know.
 */
export const DeleteTask = ({ onDeleted, task }: DeleteTaskProps) => {
  const remove = useDeleteTask();
  const { mutate } = remove;

  const confirm = useCallback(() => {
    mutate(task.id, { onSuccess: onDeleted });
  }, [mutate, onDeleted, task.id]);

  return (
    <AlertDialog>
      <AlertDialogTrigger
        render={
          <Button
            className="w-fit text-destructive hover:bg-destructive/10 hover:text-destructive"
            size="sm"
            variant="ghost"
          />
        }
      >
        <HugeiconsIcon icon={Delete02Icon} strokeWidth={2} />
        Delete task
      </AlertDialogTrigger>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>Delete “{task.title}”?</AlertDialogTitle>
          <AlertDialogDescription>
            Its messages, sessions, runs and artifacts go with it. There is no
            undo.
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel>Keep</AlertDialogCancel>
          <AlertDialogAction
            disabled={remove.isPending}
            onClick={confirm}
            variant="destructive"
          >
            Delete
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
};
