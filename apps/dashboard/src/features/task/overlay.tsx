import type { RunId, TaskId } from "@workspace/domain";
import { Sheet, SheetContent } from "@workspace/ui/components/sheet";
import { useCallback, useState } from "react";
import { TaskDetailView } from "@/features/task/detail";
import type { TaskTab } from "@/routes/search";

interface TaskOverlayProps {
  /** Called with `false` when the panel closes; the route drops the search param. */
  readonly onOpenChange: (open: boolean) => void;
  /** The task to show, or null for no overlay at all. */
  readonly taskId: TaskId | null;
}

/**
 * One task, read and worked over the top of the board.
 *
 * A side panel rather than the task page: a card opened from the board is
 * usually a glance — at what the run is doing, at a message — and a page
 * navigation throws the board's scroll and drag state away for it. The board
 * stays mounted behind the panel, so closing puts the reader back where they
 * were. Like the conversation overlay, visibility is a fact about the URL, so
 * the back button closes the panel and a link to `/?task=` opens it. The full
 * page at `/tasks/<taskId>` still stands: the Telegram bot already links there.
 *
 * The width is spelled as `data-[side=right]:` variants because the primitive
 * caps a right-hand panel with variants of its own, which a plainer class loses
 * to. The name sits on the panel rather than only in its header: the header's
 * title arrives with the task, and the dialog is announced before that.
 */
export const TaskOverlay = ({ onOpenChange, taskId }: TaskOverlayProps) => {
  const close = useCallback(() => onOpenChange(false), [onOpenChange]);

  return (
    <Sheet onOpenChange={onOpenChange} open={taskId !== null}>
      <SheetContent
        aria-label="Task"
        className="gap-0 p-0 data-[side=right]:w-full data-[side=right]:sm:max-w-xl data-[side=right]:lg:max-w-3xl"
        // The sheet's own close floats over the top-right corner, which here
        // is the header's action row — the buttons would be under it. The
        // header draws a close of its own in that row instead.
        showCloseButton={false}
        side="right"
      >
        {taskId === null ? null : (
          <TaskPeek key={taskId} onClosed={close} taskId={taskId} />
        )}
      </SheetContent>
    </Sheet>
  );
};

interface TaskPeekProps {
  /** A deleted task has nothing left to show, so deleting closes the panel. */
  readonly onClosed: () => void;
  readonly taskId: TaskId;
}

/**
 * The task body with its own idea of what is selected.
 *
 * Unlike the task page, the overlay keeps the open tab and chosen run in local
 * state: the board's URL validates only its own parameters, so selections made
 * here cannot live there. Keying the panel by task id at the call site resets
 * them when one open task is swapped for another.
 */
const TaskPeek = ({ onClosed, taskId }: TaskPeekProps) => {
  const [tab, setTab] = useState<TaskTab>("details");
  const [runId, setRunId] = useState<RunId | undefined>(undefined);

  const selectRun = useCallback((next: RunId) => {
    setRunId(next);
    setTab("runs");
  }, []);

  return (
    // The panel's own box, not a scroll container: the body inside decides what
    // scrolls, so the conversation can keep its footing at the bottom of the
    // sheet instead of below however many messages there are.
    <div className="flex min-h-0 min-w-0 flex-1 flex-col p-4 sm:p-5">
      <TaskDetailView
        onClose={onClosed}
        onDeleted={onClosed}
        onSelectRun={selectRun}
        onSelectTab={setTab}
        runId={runId}
        tab={tab}
        taskId={taskId}
      />
    </div>
  );
};
