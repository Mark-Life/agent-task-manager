import { LinkBackwardIcon } from "@hugeicons/core-free-icons";
import { createRoute } from "@tanstack/react-router";
import type { RunId, TaskId } from "@workspace/domain";
import { SidebarTrigger } from "@workspace/ui/components/sidebar";
import { useCallback } from "react";
import { EmptyState } from "@/components/empty-state";
import { RouteError } from "@/components/error-boundary";
import { TaskDetailView } from "@/features/task/detail";
import { layoutRoute } from "@/routes/layout";
import {
  parseRunId,
  parseTaskId,
  parseTaskTab,
  type TaskTab,
} from "@/routes/search";

/**
 * Both parameters name something the reader chose to look at, which is why they
 * are in the URL: a link to one attempt of one task, on the panel it is about,
 * is the thing an operator sends to themselves at three in the morning.
 */
export interface TaskSearch {
  readonly runId?: RunId;
  readonly tab?: TaskTab;
}

const validateSearch = (search: Record<string, unknown>): TaskSearch => ({
  runId: parseRunId(search.runId),
  tab: parseTaskTab(search.tab),
});

interface TaskPageProps {
  readonly runId: RunId | undefined;
  readonly tab: TaskTab;
  readonly taskId: TaskId;
}

/**
 * The task page: the shared task body on its own address, with the open tab
 * and chosen run kept in the URL so a link lands on exactly this view of it.
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
const TaskScreen = () => {
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

/**
 * The one address that is a contract with something outside this app: the
 * Telegram bot builds task links as `/tasks/<taskId>`, so this path is fixed
 * and cannot be reshaped without breaking every notification already sent.
 */
export const taskRoute = createRoute({
  component: TaskScreen,
  errorComponent: RouteError,
  getParentRoute: () => layoutRoute,
  path: "/tasks/$taskId",
  validateSearch,
});
