import {
  type InfiniteData,
  infiniteQueryOptions,
  useInfiniteQuery,
} from "@tanstack/react-query";
import type { RunEvent } from "@workspace/api";
import type { RunEventKind, RunId, TaskId } from "@workspace/domain";
import type { Effect } from "effect";
import { useMemo } from "react";
import { apiInfiniteQuery } from "@/api/infinite";
import { keys } from "@/api/keys";
import { apiQuery } from "@/api/query";
import type { ApiClientShape } from "@/api/runtime";

type RunClient = ApiClientShape["runs"];

/** One page of a timeline, taken from the call rather than restated. */
type EventPage = Effect.Success<ReturnType<RunClient["events"]>>;

/** How far into a run's timeline a page has read. Absent starts at the beginning. */
type Cursor = number | undefined;

/** How often a live run's timeline is re-read. Slow enough to be cheap, fast enough to feel live. */
const POLL_MS = 3000;

/** The three events after which nothing else arrives on a run. */
const TERMINAL_KINDS: readonly RunEventKind[] = [
  "failed",
  "finished",
  "stopped",
];

const endsTheRun = (event: RunEvent) =>
  TERMINAL_KINDS.includes(event.payload.kind);

/** A task's attempts, newest first. */
export const runsQuery = (taskId: TaskId) =>
  apiQuery(keys.runs(taskId), (client) =>
    client.runs.list({ params: { taskId } })
  );

/** One attempt: what it ran, what it cost, and how it ended. */
export const runQuery = (taskId: TaskId, runId: RunId) =>
  apiQuery(keys.run(taskId, runId), (client) =>
    client.runs.get({ params: { runId, taskId } })
  );

/**
 * Whether the timeline has read the event that ends the run.
 *
 * The run's own status would answer this too, but it is a second read that can
 * disagree with the events on screen; the timeline stops polling on what it has
 * actually rendered.
 */
export const isRunComplete = (data: InfiniteData<EventPage> | undefined) =>
  data?.pages.some((page) => page.events.some(endsTheRun)) ?? false;

/**
 * Poll while the run is still producing events, and stop the moment it is not.
 *
 * A refetch re-reads each page from the cursor it was fetched with, so the last
 * one picks up whatever arrived after it — the tail grows without a second
 * mechanism. The contract's SSE stream would be cheaper and cannot be used: its
 * codec does not decode the events the server emits.
 */
const pollWhileRunning = (query: {
  readonly state: { readonly data: InfiniteData<EventPage> | undefined };
}) => (isRunComplete(query.state.data) ? false : POLL_MS);

/**
 * A run's timeline, oldest first, paged forward by sequence number.
 *
 * `live` is the caller's knowledge of whether this run is the task's current
 * one; polling is off for a finished run, so an old run read from history costs
 * exactly one request per page.
 */
export const runEventsQuery = (taskId: TaskId, runId: RunId, live: boolean) =>
  infiniteQueryOptions({
    ...apiInfiniteQuery({
      cursorOf: (page: EventPage): Cursor => page.nextSeq ?? undefined,
      from: undefined as Cursor,
      queryKey: keys.runEvents(taskId, runId),
      request: (cursor: Cursor, client: ApiClientShape) =>
        client.runs.events({
          params: { runId, taskId },
          query: cursor === undefined ? {} : { afterSeq: cursor },
        }),
    }),
    refetchInterval: live ? pollWhileRunning : false,
  });

/**
 * The timeline as a screen wants it: one flat list, and whether the run is over.
 *
 * Flattening here rather than in the component keeps the paging shape out of the
 * renderer, which cares about events in order and nothing else. The query itself
 * is handed back for the "load more" button and the pending state.
 */
export const useRunEvents = (taskId: TaskId, runId: RunId, live: boolean) => {
  const query = useInfiniteQuery(runEventsQuery(taskId, runId, live));
  const { data } = query;
  const events = useMemo(
    () => data?.pages.flatMap((page) => page.events) ?? [],
    [data]
  );
  return { events, isComplete: isRunComplete(data), query };
};
