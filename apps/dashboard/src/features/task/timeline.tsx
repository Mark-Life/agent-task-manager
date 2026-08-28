import { HistoryIcon } from "@hugeicons/core-free-icons";
import type { RunId, TaskId } from "@workspace/domain";
import { Button } from "@workspace/ui/components/button";
import { Spinner } from "@workspace/ui/components/spinner";
import { Tabs, TabsList, TabsTrigger } from "@workspace/ui/components/tabs";
import { useCallback } from "react";
import { useRunEvents } from "@/api/runs";
import { EmptyState } from "@/components/empty-state";
import { Pending } from "@/components/query-state";
import { RunChat } from "@/features/task/timeline-chat";
import { RunTable } from "@/features/task/timeline-table";
import { failureText } from "@/lib/failure";
import { useUpdateHold } from "@/pwa/hold";
import { RUN_VIEWS, type RunView } from "@/routes/search";

/** What each reading is called on the control that switches between them. */
const VIEW_LABELS: Record<RunView, string> = {
  chat: "Chat",
  table: "Events",
};

interface RunTimelineProps {
  /** Whether this is the attempt a container is working on right now. */
  readonly live: boolean;
  readonly onSelectView: (view: RunView) => void;
  readonly runId: RunId;
  readonly taskId: TaskId;
  readonly view: RunView;
}

/**
 * What a run did, in the order it did it.
 *
 * The events are paged forward by the sequence number the container wrote, and
 * a live run is polled rather than streamed: the contract's event stream cannot
 * be decoded by a derived client today. Polling stops on the terminal event the
 * list has actually rendered, so a finished attempt read out of history costs
 * one request per page and nothing after that.
 *
 * Two readings of the same list, and the paging is shared between them: the
 * events come from one query whichever is on screen, so switching does not
 * refetch, does not reset how far the reader has paged, and does not move them
 * on the page. Both readings append at the bottom as a live run writes, and
 * neither keys anything by position, so an arriving page leaves what is above it
 * exactly as it was.
 */
export const RunTimeline = ({
  live,
  onSelectView,
  runId,
  taskId,
  view,
}: RunTimelineProps) => {
  const { events, isComplete, query } = useRunEvents(taskId, runId, live);

  // Somebody is watching a run arrive. A reload here drops the timeline back to
  // its first page and refetches from the top, which is the moment being
  // watched taken away, so the background update waits until the run ends or
  // the screen is left.
  useUpdateHold(live && !isComplete, "a run is being watched");

  const { fetchNextPage } = query;
  const more = useCallback(() => {
    fetchNextPage();
  }, [fetchNextPage]);

  // The tab strip hands back whatever string was clicked, and only two of them
  // are readings. Anything else is dropped rather than pushed into the URL.
  const chooseView = useCallback(
    (next: unknown) => {
      const chosen = RUN_VIEWS.find((known) => known === next);
      if (chosen !== undefined) {
        onSelectView(chosen);
      }
    },
    [onSelectView]
  );

  if (query.isPending) {
    return <Pending label="Loading events" lines={4} />;
  }
  if (events.length === 0) {
    return (
      <EmptyState
        description="Events arrive as the container writes them."
        icon={HistoryIcon}
        title="Nothing recorded yet"
      />
    );
  }

  return (
    <div className="flex flex-col gap-3">
      <Tabs className="self-start" onValueChange={chooseView} value={view}>
        <TabsList variant="line">
          {RUN_VIEWS.map((name) => (
            <TabsTrigger key={name} value={name}>
              {VIEW_LABELS[name]}
            </TabsTrigger>
          ))}
        </TabsList>
      </Tabs>

      {view === "chat" ? (
        <RunChat events={events} />
      ) : (
        <RunTable events={events} />
      )}

      {failureText(query.error) === null ? null : (
        <p className="text-destructive text-xs">{failureText(query.error)}</p>
      )}
      <div className="flex items-center gap-3">
        {query.hasNextPage ? (
          <Button
            disabled={query.isFetchingNextPage}
            onClick={more}
            size="sm"
            variant="outline"
          >
            More events
          </Button>
        ) : null}
        {live && !isComplete ? (
          <span className="flex items-center gap-1.5 text-muted-foreground text-xs">
            <Spinner className="size-3" />
            watching for more
          </span>
        ) : null}
      </div>
    </div>
  );
};
