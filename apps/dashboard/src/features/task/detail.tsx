import {
  BubbleChatIcon,
  Comment01Icon,
  File01Icon,
  PlayCircleIcon,
} from "@hugeicons/core-free-icons";
import type { IconSvgElement } from "@hugeicons/react";
import { HugeiconsIcon } from "@hugeicons/react";
import { useQuery } from "@tanstack/react-query";
import type { TaskDetail } from "@workspace/api";
import type { RunId, TaskId } from "@workspace/domain";
import { Separator } from "@workspace/ui/components/separator";
import {
  Tabs,
  TabsContent,
  TabsList,
  TabsTrigger,
} from "@workspace/ui/components/tabs";
import { artifactsQuery } from "@/api/artifacts";
import { commentsQuery } from "@/api/comments";
import { runsQuery } from "@/api/runs";
import { sessionsQuery } from "@/api/sessions";
import { taskQuery } from "@/api/tasks";
import { Failed, Pending } from "@/components/query-state";
import { TaskActions } from "@/features/task/actions";
import { TaskArtifacts } from "@/features/task/artifacts";
import { TaskBrief } from "@/features/task/brief";
import { TaskComments } from "@/features/task/comments";
import { TaskHeader } from "@/features/task/header";
import { TaskProperties } from "@/features/task/properties";
import { TaskRuns, useCurrentRun } from "@/features/task/runs";
import { TaskSessions } from "@/features/task/sessions";
import { RunTimeline } from "@/features/task/timeline";
import { TASK_TABS, type TaskTab } from "@/routes/search";

/** How often an unsettled task re-reads itself. The cadence the board already uses per in-progress card. */
const TASK_POLL_MS = 5000;

/** What each panel is called, and the mark it is recognised by. */
const TAB_FACES: Record<TaskTab, { icon: IconSvgElement; label: string }> = {
  artifacts: { icon: File01Icon, label: "Files" },
  comments: { icon: Comment01Icon, label: "Comments" },
  runs: { icon: PlayCircleIcon, label: "Runs" },
  sessions: { icon: BubbleChatIcon, label: "Sessions" },
};

/**
 * Whether this task can still change without anyone touching the page: a run is
 * working on it, or it sits in progress waiting for a slot. Both end on the
 * orchestrator's clock and nothing tells the browser when they do, so a page
 * left open has to keep asking until the task settles — and then stop.
 */
const isUnsettled = (detail: TaskDetail) =>
  detail.liveRunId !== null || detail.task.status === "in_progress";

/**
 * How much is behind each tab.
 *
 * A row of names says nothing about which of them is worth opening — whether
 * this task has one comment or forty, whether anything ever ran on it. The
 * counts are read here, above the tabs, which also means the panel a reader
 * switches to is already in the cache and draws without a skeleton. Undefined
 * until the list arrives, so a count never flashes zero on the way to five.
 */
const useTabCounts = (taskId: TaskId): Record<TaskTab, number | undefined> => {
  const artifacts = useQuery(artifactsQuery(taskId));
  const comments = useQuery(commentsQuery(taskId));
  const runs = useQuery(runsQuery(taskId));
  const sessions = useQuery(sessionsQuery(taskId));

  return {
    artifacts: artifacts.data?.length,
    comments: comments.data?.length,
    runs: runs.data?.length,
    sessions: sessions.data?.length,
  };
};

/** The count beside a tab name, drawn only when there is something to count. */
const TabCount = ({ value }: { readonly value: number | undefined }) =>
  value === undefined || value === 0 ? null : (
    <span className="rounded-full bg-muted px-1.5 text-[0.625rem] text-muted-foreground tabular-nums">
      {value}
    </span>
  );

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

interface TaskDetailViewProps {
  /** Draws a close button in the header — the overlay's way out. */
  readonly onClose?: () => void;
  /** Called once the task is gone: the page leaves for the board, the overlay closes. */
  readonly onDeleted: () => void;
  readonly onSelectRun: (runId: RunId) => void;
  readonly onSelectTab: (tab: TaskTab) => void;
  readonly runId: RunId | undefined;
  readonly tab: TaskTab;
  readonly taskId: TaskId;
}

/**
 * Everything known about one task, as one body.
 *
 * Shared between the task page, where the tab and run are facts about the URL,
 * and the board's overlay, where they are local to the panel: which one is
 * selected and what selecting does belongs to whoever mounted this, so both
 * draw the same task the same way.
 *
 * The task is read in one place here and handed down, so the header, the
 * property rows, the buttons and the brief cannot disagree about what status
 * the task is in or whether a run is on it. What is behind a tab is the
 * material a reader goes looking for rather than the state they need at a
 * glance, which stays above.
 *
 * The body reads top to bottom as what the task is, then what it asks for, then
 * what has happened to it, with a rule between each — three questions rather
 * than one column of everything. The tab bar sticks to the top of whatever is
 * scrolling, because a long conversation otherwise scrolls the only way out of
 * itself off the screen.
 */
export const TaskDetailView = ({
  onClose,
  onDeleted,
  onSelectRun,
  onSelectTab,
  runId,
  tab,
  taskId,
}: TaskDetailViewProps) => {
  const detail = useQuery({
    ...taskQuery(taskId),
    refetchInterval: ({ state }) =>
      state.data === undefined || isUnsettled(state.data)
        ? TASK_POLL_MS
        : false,
  });
  const currentRun = useCurrentRun(taskId, runId);
  const counts = useTabCounts(taskId);

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
    <>
      <TaskHeader
        detail={detail.data}
        onClose={onClose}
        onDeleted={onDeleted}
      />
      <TaskActions detail={detail.data} />

      {/* The rules sit closer to what they divide than the column's own rhythm
          would put them: a full gap on each side of a hairline reads as two
          gaps, and the top of this panel is mostly gap already. */}
      <Separator className="-my-1" />
      <TaskProperties task={detail.data.task} />

      <Separator className="-my-1" />
      <TaskBrief task={detail.data.task} />

      <Tabs className="gap-0" onValueChange={onSelectTab} value={tab}>
        <div className="sticky top-0 z-10 bg-background pt-2 pb-1">
          <TabsList className="w-full justify-start" variant="line">
            {TASK_TABS.map((name) => (
              <TabsTrigger className="flex-none" key={name} value={name}>
                <HugeiconsIcon icon={TAB_FACES[name].icon} strokeWidth={2} />
                {TAB_FACES[name].label}
                <TabCount value={counts[name]} />
              </TabsTrigger>
            ))}
          </TabsList>
        </div>
        <TabsContent className="pt-5" value="runs">
          <RunsPanel
            liveRunId={detail.data.liveRunId}
            onSelectRun={onSelectRun}
            runId={currentRun}
            taskId={taskId}
          />
        </TabsContent>
        <TabsContent className="pt-5" value="comments">
          <TaskComments taskId={taskId} />
        </TabsContent>
        <TabsContent className="pt-5" value="sessions">
          <TaskSessions task={detail.data.task} />
        </TabsContent>
        <TabsContent className="pt-5" value="artifacts">
          <TaskArtifacts taskId={taskId} />
        </TabsContent>
      </Tabs>
    </>
  );
};
