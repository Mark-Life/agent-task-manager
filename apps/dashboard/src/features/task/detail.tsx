import {
  BubbleChatIcon,
  File01Icon,
  FileEditIcon,
  Note01Icon,
  PlayCircleIcon,
  Robot01Icon,
} from "@hugeicons/core-free-icons";
import type { IconSvgElement } from "@hugeicons/react";
import { HugeiconsIcon } from "@hugeicons/react";
import { useQuery } from "@tanstack/react-query";
import type { TaskDetail } from "@workspace/api";
import type { RunId, TaskId } from "@workspace/domain";
import {
  Tabs,
  TabsContent,
  TabsList,
  TabsTrigger,
} from "@workspace/ui/components/tabs";
import { artifactsQuery } from "@/api/artifacts";
import { taskMessagesQuery } from "@/api/messages";
import { proposalsQuery } from "@/api/proposals";
import { runsQuery } from "@/api/runs";
import { sessionsQuery } from "@/api/sessions";
import { taskQuery } from "@/api/tasks";
import { Failed, Pending } from "@/components/query-state";
import { TaskActions } from "@/features/task/actions";
import { TaskArtifacts } from "@/features/task/artifacts";
import { TaskDetails } from "@/features/task/details";
import { TaskHeader } from "@/features/task/header";
import { TaskMessages } from "@/features/task/messages";
import { TaskProposals } from "@/features/task/proposals";
import { TaskRuns, useCurrentRun } from "@/features/task/runs";
import { TaskSessions } from "@/features/task/sessions";
import { RunTimeline } from "@/features/task/timeline";
import { TASK_TABS, type TaskTab } from "@/routes/search";

/** How often an unsettled task re-reads itself. The cadence the board already uses per in-progress card. */
const TASK_POLL_MS = 5000;

/** What each panel is called, and the mark it is recognised by. */
const TAB_FACES: Record<TaskTab, { icon: IconSvgElement; label: string }> = {
  artifacts: { icon: File01Icon, label: "Files" },
  details: { icon: Note01Icon, label: "Details" },
  messages: { icon: BubbleChatIcon, label: "Messages" },
  proposals: { icon: FileEditIcon, label: "Proposals" },
  runs: { icon: PlayCircleIcon, label: "Runs" },
  sessions: { icon: Robot01Icon, label: "Sessions" },
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
 * this task has one message or forty, whether anything ever ran on it. The
 * counts are read here, above the tabs, which also means the panel a reader
 * switches to is already in the cache and draws without a skeleton. Undefined
 * until the list arrives, so a count never flashes zero on the way to five.
 *
 * Details is absent on purpose: a task has one brief, and "1" beside it counts
 * nothing a reader was wondering about.
 */
const useTabCounts = (taskId: TaskId): Partial<Record<TaskTab, number>> => {
  const artifacts = useQuery(artifactsQuery(taskId));
  const messages = useQuery(taskMessagesQuery(taskId));
  const proposals = useQuery(proposalsQuery(taskId));
  const runs = useQuery(runsQuery(taskId));
  const sessions = useQuery(sessionsQuery(taskId));

  return {
    artifacts: artifacts.data?.length,
    messages: messages.data?.length,
    // The waiting ones alone. Every other count says how much is behind a tab;
    // this one says how much is waiting on the reader, and a decided proposal
    // is a record rather than a thing to do.
    proposals: proposals.data?.filter(
      (proposal) => proposal.state === "pending"
    ).length,
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
 * the task is in or whether a run is on it.
 *
 * Two parts, not three: a fixed head — what the task is called, where it sits,
 * what can be done to the run on it — and one panel under the tab strip that
 * takes the whole of the rest and scrolls inside itself. The brief and the
 * property rows are a panel now like any other, which is what lets the head
 * stay short: they used to stand above the strip, so opening a task with a long
 * brief meant scrolling past it to reach the conversation every time.
 *
 * The panel is unframed. A card inside a sheet is a border inside a border, and
 * with the tab strip's own rule under it the reader was being shown three
 * nested edges to be told one thing — that this is the part that changes when
 * you pick a tab, which the strip already says.
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
    // `min-w-0` all the way down: a flex item defaults to `min-width: auto`, so
    // without it any row that cannot fit — a tab strip, a file path — widens
    // this column instead of scrolling inside itself, and on a phone the whole
    // panel slides off the side of the screen.
    <div className="flex min-h-0 min-w-0 flex-1 flex-col gap-3">
      {/* The head keeps its height: it is two lines and a row of verbs, and
          nothing here is worth taking from the panel below. */}
      <div className="flex min-w-0 shrink-0 flex-col gap-3">
        <TaskHeader detail={detail.data} onClose={onClose} />
        <TaskActions detail={detail.data} />
      </div>

      <Tabs
        className="flex min-h-96 min-w-0 flex-1 flex-col gap-0 overflow-hidden"
        onValueChange={onSelectTab}
        value={tab}
      >
        {/* The active tab is marked by a rule two pixels under it, which is
            what the bottom padding lines up with the border for — one line, not
            two parallel ones.

            Five names and their counts do not fit across a phone, so the strip
            scrolls sideways rather than growing the panel. Its scrollbar is
            hidden: the row is one line tall and a bar under it would sit on the
            active tab's mark. */}
        <div className="flex min-w-0 shrink-0 items-center overflow-x-auto border-border border-b pb-0.5 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
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

        {/* Messages fill the body and hold their own scroller and their own
            box to type into, so this panel only makes room. The rest scroll as
            ordinary content, with `pr` leaving the scrollbar its own lane so
            the text does not shift when one appears. */}
        <TabsContent
          className="min-h-0 min-w-0 flex-1 overflow-y-auto py-4 pr-1"
          value="details"
        >
          <TaskDetails onDeleted={onDeleted} task={detail.data.task} />
        </TabsContent>
        <TabsContent
          className="flex min-h-0 min-w-0 flex-1 flex-col"
          value="messages"
        >
          <TaskMessages taskId={taskId} />
        </TabsContent>
        <TabsContent
          className="min-h-0 min-w-0 flex-1 overflow-y-auto py-4 pr-1"
          value="runs"
        >
          <RunsPanel
            liveRunId={detail.data.liveRunId}
            onSelectRun={onSelectRun}
            runId={currentRun}
            taskId={taskId}
          />
        </TabsContent>
        <TabsContent
          className="min-h-0 min-w-0 flex-1 overflow-y-auto py-4 pr-1"
          value="sessions"
        >
          <TaskSessions task={detail.data.task} />
        </TabsContent>
        <TabsContent
          className="min-h-0 min-w-0 flex-1 overflow-y-auto py-4 pr-1"
          value="artifacts"
        >
          <TaskArtifacts taskId={taskId} />
        </TabsContent>
        <TabsContent
          className="min-h-0 min-w-0 flex-1 overflow-y-auto py-4 pr-1"
          value="proposals"
        >
          <TaskProposals taskId={taskId} />
        </TabsContent>
      </Tabs>
    </div>
  );
};
