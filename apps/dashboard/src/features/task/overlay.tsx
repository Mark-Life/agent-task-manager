import type { RunId, TaskId } from "@workspace/domain";
import { Sheet, SheetContent } from "@workspace/ui/components/sheet";
import { lazy, Suspense, useCallback, useState } from "react";
import { Pending } from "@/components/query-state";
import type { RunView, TaskTab } from "@/routes/search";

/**
 * The task body, fetched the first time a card is opened.
 *
 * The board mounts this panel closed on every visit, and the body behind it is
 * the largest screen in the app — six panels, an artifact preview and a file
 * viewer. Loading it on the open keeps the board's own arrival to the board.
 * The task page at `/tasks/<taskId>` imports the same module outright, since
 * there it is the page rather than something that might be asked for.
 */
const TaskDetailView = lazy(() =>
  import("@/features/task/detail").then((module) => ({
    default: module.TaskDetailView,
  }))
);

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
 * Unlike the task page, the overlay keeps the open tab, the chosen run and the
 * reading its timeline is in as local state: the board's URL validates only its
 * own parameters, so selections made here cannot live there. A reader who wants
 * to send one of these has the task's own page to send. Keying the panel by task
 * id at the call site resets them when one open task is swapped for another.
 */
const TaskPeek = ({ onClosed, taskId }: TaskPeekProps) => {
  const [tab, setTab] = useState<TaskTab>("details");
  const [runId, setRunId] = useState<RunId | undefined>(undefined);
  const [runView, setRunView] = useState<RunView>("chat");

  const selectRun = useCallback((next: RunId) => {
    setRunId(next);
    setTab("runs");
  }, []);

  return (
    // The panel's own box, not a scroll container: the body inside decides what
    // scrolls, so the conversation can keep its footing at the bottom of the
    // sheet instead of below however many messages there are.
    <div className="flex min-h-0 min-w-0 flex-1 flex-col p-4 sm:p-5">
      {/*
        The same skeleton the task's own fields arrive behind, so waiting for
        the panel's code and waiting for its contents look alike.
      */}
      <Suspense fallback={<Pending label="Opening task" lines={4} />}>
        <TaskDetailView
          onClose={onClosed}
          onDeleted={onClosed}
          onSelectRun={selectRun}
          onSelectRunView={setRunView}
          onSelectTab={setTab}
          runId={runId}
          runView={runView}
          tab={tab}
          taskId={taskId}
        />
      </Suspense>
    </div>
  );
};
