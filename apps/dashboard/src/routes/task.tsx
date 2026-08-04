import { useQuery } from "@tanstack/react-query";
import { createRoute } from "@tanstack/react-router";
import type { TaskDetail } from "@workspace/api";
import type { RunId, TaskId } from "@workspace/domain";
import {
  Empty,
  EmptyDescription,
  EmptyHeader,
  EmptyTitle,
} from "@workspace/ui/components/empty";
import {
  Tabs,
  TabsContent,
  TabsList,
  TabsTrigger,
} from "@workspace/ui/components/tabs";
import { useCallback } from "react";
import { taskQuery } from "@/api/tasks";
import { RouteError } from "@/components/error-boundary";
import { Failed, Pending } from "@/components/query-state";
import { TaskActions } from "@/features/task/actions";
import { TaskArtifacts } from "@/features/task/artifacts";
import { TaskBrief } from "@/features/task/brief";
import { TaskComments } from "@/features/task/comments";
import { TaskHeader } from "@/features/task/header";
import { TaskRuns, useCurrentRun } from "@/features/task/runs";
import { TaskSessions } from "@/features/task/sessions";
import { RunTimeline } from "@/features/task/timeline";
import { layoutRoute } from "@/routes/layout";
import {
  parseRunId,
  parseTaskId,
  parseTaskTab,
  TASK_TABS,
  type TaskTab,
} from "@/routes/search";

/** How often an unsettled task re-reads itself. The cadence the board already uses per in-progress card. */
const TASK_POLL_MS = 5000;

/** What each panel is called. The order they are drawn in is the tab order. */
const TAB_LABELS: Record<TaskTab, string> = {
  artifacts: "Files",
  comments: "Comments",
  runs: "Runs",
  sessions: "Sessions",
};

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

interface RunsPanelProps {
  readonly liveRunId: RunId | null;
  readonly onSelectRun: (runId: RunId) => void;
  readonly runId: RunId | undefined;
  readonly taskId: TaskId;
}

/**
 * The attempts, and what the selected one did.
 *
 * The timeline is only drawn once an attempt exists — a task nobody has spent a
 * run on has no events to page, and an empty timeline under an empty run list
 * says the same nothing twice.
 */
const RunsPanel = ({
  liveRunId,
  onSelectRun,
  runId,
  taskId,
}: RunsPanelProps) => (
  <div className="flex flex-col gap-6">
    <TaskRuns onSelectRun={onSelectRun} selectedRunId={runId} taskId={taskId} />
    {runId === undefined ? null : (
      <RunTimeline live={liveRunId === runId} runId={runId} taskId={taskId} />
    )}
  </div>
);

/**
 * Whether this task can still change without anyone touching the page: a run is
 * working on it, or it sits in progress waiting for a slot. Both end on the
 * orchestrator's clock and nothing tells the browser when they do, so a page
 * left open has to keep asking until the task settles — and then stop.
 */
const isUnsettled = (detail: TaskDetail) =>
  detail.liveRunId !== null || detail.task.status === "in_progress";

interface TaskPageProps {
  readonly runId: RunId | undefined;
  readonly tab: TaskTab;
  readonly taskId: TaskId;
}

/**
 * Everything known about one task, on one page.
 *
 * The task is read in one place here and handed down, so the header, the
 * buttons and the brief cannot disagree about what status the task is in or
 * whether a run is on it. What is behind a tab is the material a reader goes
 * looking for rather than the state they need at a glance, which stays above.
 */
const TaskPage = ({ runId, tab, taskId }: TaskPageProps) => {
  const navigate = taskRoute.useNavigate();
  const detail = useQuery({
    ...taskQuery(taskId),
    refetchInterval: ({ state }) =>
      state.data === undefined || isUnsettled(state.data)
        ? TASK_POLL_MS
        : false,
  });
  const currentRun = useCurrentRun(taskId, runId);

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

  const openComments = useCallback(() => selectTab("comments"), [selectTab]);

  // A deleted task's page no longer resolves, so leaving is part of deleting
  // rather than something the reader is asked to do next.
  const goToBoard = useCallback(() => {
    navigate({ to: "/" });
  }, [navigate]);

  if (detail.isPending) {
    return <Pending className="p-6" label="Loading task" lines={5} />;
  }

  if (detail.isError) {
    return (
      <Failed
        error={detail.error}
        onRetry={detail.refetch}
        title="That task did not load"
      />
    );
  }

  return (
    <div className="mx-auto flex w-full max-w-4xl flex-col gap-8 px-6 py-8">
      <TaskHeader detail={detail.data} onDeleted={goToBoard} />
      <TaskActions detail={detail.data} onComment={openComments} />
      <TaskBrief task={detail.data.task} />

      <Tabs onValueChange={selectTab} value={tab}>
        <TabsList variant="line">
          {TASK_TABS.map((name) => (
            <TabsTrigger key={name} value={name}>
              {TAB_LABELS[name]}
            </TabsTrigger>
          ))}
        </TabsList>
        <TabsContent className="pt-4" value="runs">
          <RunsPanel
            liveRunId={detail.data.liveRunId}
            onSelectRun={selectRun}
            runId={currentRun}
            taskId={taskId}
          />
        </TabsContent>
        <TabsContent className="pt-4" value="comments">
          <TaskComments taskId={taskId} />
        </TabsContent>
        <TabsContent className="pt-4" value="sessions">
          <TaskSessions task={detail.data.task} />
        </TabsContent>
        <TabsContent className="pt-4" value="artifacts">
          <TaskArtifacts taskId={taskId} />
        </TabsContent>
      </Tabs>
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
      <Empty className="py-12">
        <EmptyHeader>
          <EmptyTitle>That is not a task address</EmptyTitle>
          <EmptyDescription>
            The identifier in this link is not one this workspace could have
            issued. Check the link, or find the task on the board.
          </EmptyDescription>
        </EmptyHeader>
      </Empty>
    );
  }

  return <TaskPage runId={runId} tab={tab ?? "runs"} taskId={parsed} />;
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
