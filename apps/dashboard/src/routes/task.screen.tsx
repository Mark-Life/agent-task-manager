import { LinkBackwardIcon } from "@hugeicons/core-free-icons";
import type { RunId, TaskId } from "@workspace/domain";
import { SidebarTrigger } from "@workspace/ui/components/sidebar";
import { useCallback } from "react";
import { EmptyState } from "@/components/empty-state";
import { TaskDetailView } from "@/features/task/detail";
import { parseTaskId, type TaskTab } from "@/routes/search";
import { taskRoute } from "@/routes/task";

interface TaskPageProps {
  readonly runId: RunId | undefined;
  readonly tab: TaskTab;
  readonly taskId: TaskId;
}

/**
 * The task page: the shared task body on its own address, with the open tab
 * and chosen run kept in the URL so a link lands on exactly this view of it.
 *
 * The route it hangs off is imported rather than named by id — see the note in
 * `board.screen.tsx` for why that is not the cycle it looks like.
 */
const TaskPage = ({ runId, tab, taskId }: TaskPageProps) => {
  const navigate = taskRoute.useNavigate();

  const selectTab = useCallback(
    (next: TaskTab) => {
      navigate({ search: (previous) => ({ ...previous, tab: next }), to: "." });
    },
    [navigate]
  );

  const selectRun = useCallback(
    (next: RunId) => {
      navigate({
        search: (previous) => ({ ...previous, runId: next, tab: "runs" }),
        to: ".",
      });
    },
    [navigate]
  );

  // A deleted task's page no longer resolves, so leaving is part of deleting
  // rather than something the reader is asked to do next.
  const goToBoard = useCallback(() => {
    navigate({ to: "/" });
  }, [navigate]);

  return (
    // Bounded rather than growing, for the same reason the overlay is: the
    // conversation panel below holds its own scroller and the box to type into,
    // and both need a height to sit in.
    <div className="mx-auto flex h-full min-h-0 w-full min-w-0 max-w-4xl flex-col px-4 py-4 sm:px-6 sm:py-6">
      {/*
        The task's own header is shared with the overlay, which opens over a
        page that already has this button — so the trigger sits here, on the
        page, rather than in there.
      */}
      <SidebarTrigger className="mb-2 shrink-0 self-start md:hidden" />
      <TaskDetailView
        onDeleted={goToBoard}
        onSelectRun={selectRun}
        onSelectTab={selectTab}
        runId={runId}
        tab={tab}
        taskId={taskId}
      />
    </div>
  );
};

/**
 * The task page, guarded by the shape of its own address.
 *
 * The path segment is whatever was in the URL bar, so it is decoded against the
 * domain's id before anything is read with it: a mistyped link then says so
 * instead of sending a malformed request and rendering the server's refusal.
 */
export const TaskScreen = () => {
  const { taskId } = taskRoute.useParams();
  const { runId, tab } = taskRoute.useSearch();
  const parsed = parseTaskId(taskId);

  if (parsed === undefined) {
    return (
      <EmptyState
        className="py-12"
        description="The identifier in this link is not one this workspace could have issued. Check the link, or find the task on the board."
        icon={LinkBackwardIcon}
        title="That is not a task address"
      />
    );
  }

  return <TaskPage runId={runId} tab={tab ?? "details"} taskId={parsed} />;
};
