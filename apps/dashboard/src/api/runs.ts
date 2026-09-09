import {
  type InfiniteData,
  infiniteQueryOptions,
  useInfiniteQuery,
  useQueryClient,
} from "@tanstack/react-query";
import type { RunEvent } from "@workspace/api";
import type { RunEventKind, RunId, TaskId } from "@workspace/domain";
import type { Effect } from "effect";
import { useMemo } from "react";
import { apiInfiniteQuery } from "@/api/infinite";
import { keys } from "@/api/keys";
import { apiQuery } from "@/api/query";
import type { ApiClientShape } from "@/api/runtime";
import { useApiStream } from "@/api/stream";

type RunClient = ApiClientShape["runs"];

/** One page of a timeline, taken from the call rather than restated. */
type EventPage = Effect.Success<ReturnType<RunClient["events"]>>;

/** How far into a run's timeline a page has read. Absent starts at the beginning. */
type Cursor = number | undefined;

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
 * A run's timeline, oldest first, paged forward by sequence number.
 *
 * One request per page and nothing on a timer. What used to be a three-second
 * poll of the last page is now `useRunEvents` below holding the contract's
 * event stream open, which is the same rows over the same cursor — a page and a
 * stream of one run cannot disagree, because there is one append-only table
 * under both.
 */
export const runEventsQuery = (taskId: TaskId, runId: RunId) =>
  infiniteQueryOptions(
    apiInfiniteQuery({
      cursorOf: (page: EventPage): Cursor => page.nextSeq ?? undefined,
      from: undefined as Cursor,
      queryKey: keys.runEvents(taskId, runId),
      request: (cursor: Cursor, client: ApiClientShape) =>
        client.runs.events({
          params: { runId, taskId },
          query: cursor === undefined ? {} : { afterSeq: cursor },
        }),
    })
  );

/** How far the timeline on screen has read, which is where the stream opens. */
const cursorOf = (data: InfiniteData<EventPage> | undefined): Cursor =>
  data?.pages.at(-1)?.events.at(-1)?.seq;

/**
 * One arriving event, folded into the pages already read.
 *
 * Appended to the last page rather than kept beside it, so the flattening below
 * stays one ordered list and every reader — the chat reading and the table —
 * sees the tail grow without knowing where it came from.
 *
 * Two things are decided here and both are about a reconnect. An event at or
 * below the last `seq` on screen is a replay and is dropped, which is what makes
 * reopening the stream free: the cursor is re-read from the cache, and a
 * duplicate costs a comparison. And the page it lands on has its `nextSeq`
 * cleared, because forward paging and the stream would otherwise both be
 * fetching the same tail and the reader would see each event twice.
 *
 * Pure, and exported for the test beside this file: it is the one piece of the
 * live path that can be wrong in a way a screenshot would not show.
 */
export const appendEvent = (
  data: InfiniteData<EventPage> | undefined,
  event: RunEvent
): InfiniteData<EventPage> | undefined => {
  if (data === undefined) {
    return data;
  }
  const last = data.pages.at(-1);
  if (last === undefined || event.seq <= (cursorOf(data) ?? -1)) {
    return data;
  }
  return {
    ...data,
    pages: [
      ...data.pages.slice(0, -1),
      { events: [...last.events, event], nextSeq: null },
    ],
  };
};

/**
 * The timeline as a screen wants it: one flat list, and whether the run is over.
 *
 * Flattening here rather than in the component keeps the paging shape out of the
 * renderer, which cares about events in order and nothing else. The query itself
 * is handed back for the "load more" button and the pending state.
 *
 * The live tail is a held connection rather than a poll, and it is opened only
 * once the first page has arrived — that is the contract's own protocol: page
 * back through what happened, note the cursor the last page returned, open the
 * stream from there, and miss nothing in the gap. It closes when the run ends,
 * which the server decides and this asks for twice over: `enabled` goes false
 * on the terminal event the list has actually rendered, so a finished attempt
 * read out of history holds nothing open.
 */
export const useRunEvents = (taskId: TaskId, runId: RunId, live: boolean) => {
  const query = useInfiniteQuery(runEventsQuery(taskId, runId));
  const queryClient = useQueryClient();
  const { data } = query;
  const isComplete = isRunComplete(data);

  useApiStream({
    enabled: live && !isComplete && data !== undefined,
    onValue: (event: RunEvent) => {
      queryClient.setQueryData(keys.runEvents(taskId, runId), (held) =>
        appendEvent(held as InfiniteData<EventPage> | undefined, event)
      );
    },
    open: (client) =>
      client.runs.stream({
        params: { runId, taskId },
        // Read from the cache at the moment the connection opens, not from the
        // render that asked for it: the cursor moves with every event and is
        // not a reason to reconnect.
        query: (() => {
          const from = cursorOf(
            queryClient.getQueryData<InfiniteData<EventPage>>(
              keys.runEvents(taskId, runId)
            )
          );
          return from === undefined ? {} : { afterSeq: from };
        })(),
      }),
    subscription: `run-events:${taskId}:${runId}`,
  });

  const events = useMemo(
    () => data?.pages.flatMap((page) => page.events) ?? [],
    [data]
  );
  return { events, isComplete, query };
};
