import type { RunId, TaskId } from "@workspace/domain";
import { Button } from "@workspace/ui/components/button";
import {
  Empty,
  EmptyDescription,
  EmptyHeader,
  EmptyTitle,
} from "@workspace/ui/components/empty";
import { Skeleton } from "@workspace/ui/components/skeleton";
import { Spinner } from "@workspace/ui/components/spinner";
import { useCallback } from "react";
import { useRunEvents } from "@/api/runs";
import { failureText } from "@/features/task/actions";
import { TimelineEvent } from "@/features/task/timeline-event";

interface RunTimelineProps {
  /** Whether this is the attempt a container is working on right now. */
  readonly live: boolean;
  readonly runId: RunId;
  readonly taskId: TaskId;
}

/**
 * What a run did, in the order it did it.
 *
 * The events are paged forward by the sequence number the container wrote, and
 * a live run is polled rather than streamed: the contract's event stream cannot
 * be decoded by a derived client today. Polling stops on the terminal event the
 * list has actually rendered, so a finished attempt read out of history costs
 * one request per page and nothing after that.
 */
export const RunTimeline = ({ live, runId, taskId }: RunTimelineProps) => {
  const { events, isComplete, query } = useRunEvents(taskId, runId, live);
  const { fetchNextPage } = query;
  const more = useCallback(() => {
    fetchNextPage();
  }, [fetchNextPage]);

  if (query.isPending) {
    return <Skeleton className="h-24 w-full" />;
  }
  if (events.length === 0) {
    return (
      <Empty>
        <EmptyHeader>
          <EmptyTitle>Nothing recorded yet</EmptyTitle>
          <EmptyDescription>
            Events arrive as the container writes them.
          </EmptyDescription>
        </EmptyHeader>
      </Empty>
    );
  }

  return (
    <div className="flex flex-col gap-3">
      <ol className="flex flex-col gap-2">
        {events.map((event) => (
          <TimelineEvent event={event} key={event.id} />
        ))}
      </ol>
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
