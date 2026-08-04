import { PlusSignIcon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import type { TaskId } from "@workspace/domain";
import { Button } from "@workspace/ui/components/button";
import { useCallback, useState } from "react";
import { TaskFormDialog } from "@/features/task/task-form";

interface NewTaskProps {
  /** Where a freshly filed task leads, which is straight to its own page. */
  readonly onCreated: (taskId: TaskId) => void;
}

/**
 * Filing a task by hand, from the board.
 *
 * The same dialog the task page edits with is used to create, so a field can
 * never mean one thing on one screen and something else on the other. New work
 * lands in ideas: the board's leftmost column is where a thought goes before
 * anybody has decided it is worth a run, and starting one is a deliberate drag
 * rather than a checkbox on a form.
 */
export const NewTask = ({ onCreated }: NewTaskProps) => {
  const [open, setOpen] = useState(false);
  const openForm = useCallback(() => setOpen(true), []);

  return (
    <>
      <Button onClick={openForm} size="sm" variant="outline">
        <HugeiconsIcon icon={PlusSignIcon} strokeWidth={2} />
        New task
      </Button>
      <TaskFormDialog
        defaultStatus="ideas"
        onCreated={onCreated}
        onOpenChange={setOpen}
        open={open}
      />
    </>
  );
};
