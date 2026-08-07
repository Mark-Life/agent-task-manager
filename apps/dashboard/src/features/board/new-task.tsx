import { PlusSignIcon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { Button } from "@workspace/ui/components/button";
import { useCallback } from "react";

interface NewTaskProps {
  /** Opens the draft panel. Nothing is filed until something in it changes. */
  readonly onOpen: () => void;
}

/**
 * Filing a task by hand, from the board.
 *
 * The button only opens the draft: a task nobody has named yet lives entirely
 * on the client, so closing the panel without touching it files nothing. The
 * first changed value is the decision to keep it, and is what the draft
 * sends — there is no "File it" to press, because there is no form to be
 * wrong with in the meantime.
 *
 * On a narrow screen the label drops and the plus stands alone, so the whole
 * toolbar keeps to one row. The accessible name stays either way.
 */
export const NewTask = ({ onOpen }: NewTaskProps) => {
  const open = useCallback(() => onOpen(), [onOpen]);

  return (
    <Button
      aria-label="New task"
      // Square while the label is hidden: the row's other icon buttons are
      // 28px across, and the default padding would leave this one wider than
      // it is tall.
      className="shrink-0 max-md:size-7 max-md:px-0"
      onClick={open}
      variant="outline"
    >
      <HugeiconsIcon icon={PlusSignIcon} strokeWidth={2} />
      <span className="hidden md:inline">New task</span>
    </Button>
  );
};
