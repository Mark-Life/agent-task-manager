import {
  type QueryClient,
  useInfiniteQuery,
  useMutation,
  useQueryClient,
} from "@tanstack/react-query";
import type { ThreadId } from "@workspace/domain";
import type { Effect } from "effect";
import { useMemo } from "react";
import { apiInfiniteQuery } from "@/api/infinite";
import { keys } from "@/api/keys";
import { apiMutation, apiQuery } from "@/api/query";
import type { ApiClientShape } from "@/api/runtime";

type ThreadClient = ApiClientShape["threads"];
type ThreadFilters = Parameters<ThreadClient["list"]>[0]["query"];
type ThreadCreate = Parameters<ThreadClient["create"]>[0]["payload"];
type ThreadPatch = Parameters<ThreadClient["patch"]>[0]["payload"];
type MessagePage = Effect.Success<ReturnType<ThreadClient["messages"]>>;

/**
 * The prefix every conversation list hangs off, read out of the key factory so
 * the two spellings cannot drift. Lists differ by filter and a new message
 * reorders all of them, since the list is ordered by who spoke last.
 */
const [THREADS_ROOT, LIST_SEGMENT] = keys.threads();
const threadListsKey = [THREADS_ROOT, LIST_SEGMENT] as const;

/** A conversation's turns. Under the thread, so archiving one drops them with it. */
const threadRunsKey = (threadId: ThreadId) =>
  [...keys.thread(threadId), "runs"] as const;

/** Retitling, selecting or retiring one conversation. */
export interface ThreadEdit {
  readonly patch: ThreadPatch;
  readonly threadId: ThreadId;
}

/** Something said to the manager, and which conversation it lands in. */
export interface MessageDraft {
  readonly body: string;
  readonly threadId: ThreadId;
}

/**
 * The conversations, most recently spoken in first.
 *
 * Archived ones are absent unless asked for: a retired thread is kept for the
 * audit rows that point at it rather than for the sidebar.
 */
export const threadsQuery = (filters: ThreadFilters = {}) =>
  apiQuery(keys.threads(filters), (client) =>
    client.threads.list({ query: filters })
  );

/**
 * One conversation and the turn running on it right now.
 *
 * A null `liveRunId` under an unanswered message is a real state, the same one a
 * task in progress with no run is: the turn is waiting for a slot rather than
 * being written.
 */
export const threadQuery = (threadId: ThreadId) =>
  apiQuery(keys.thread(threadId), (client) =>
    client.threads.get({ params: { threadId } })
  );

/** A conversation's turns, newest first. One run each; their timelines read back through the runs group. */
export const threadRunsQuery = (threadId: ThreadId) =>
  apiQuery(threadRunsKey(threadId), (client) =>
    client.threads.runs({ params: { threadId } })
  );

/**
 * How many messages one page asks for.
 *
 * The endpoint answers 50 when asked for nothing and allows up to 500. A reader
 * arrives at the end of a conversation, which over a forward cursor means
 * walking every page first, so a page big enough to hold a whole conversation
 * makes that walk one request instead of one per fifty messages — and keeps each
 * poll afterwards at one request too.
 */
const MESSAGE_PAGE = 200;

/**
 * A conversation, oldest first, paged forward by offset.
 *
 * An offset rather than a timestamp cursor because a conversation is
 * append-only and read from the beginning: nothing is inserted behind the reader
 * to shift the window under them.
 */
export const threadMessagesQuery = (threadId: ThreadId) =>
  apiInfiniteQuery({
    cursorOf: (page: MessagePage) => page.nextOffset ?? undefined,
    from: 0,
    queryKey: keys.messages(threadId),
    request: (offset: number, client: ApiClientShape) =>
      client.threads.messages({
        params: { threadId },
        query: { limit: MESSAGE_PAGE, offset },
      }),
  });

/** The conversation as a transcript wants it: one flat list, oldest first. */
export const useThreadMessages = (threadId: ThreadId) => {
  const query = useInfiniteQuery(threadMessagesQuery(threadId));
  const { data } = query;
  const messages = useMemo(
    () => data?.pages.flatMap((page) => page.messages) ?? [],
    [data]
  );
  return { messages, query };
};

/**
 * What saying something changes: the conversation itself, the turn state on the
 * thread, and the order of the sidebar. The thread's detail is invalidated
 * exactly so the messages under it are not read twice for one send.
 */
const settleThread = (queryClient: QueryClient, threadId: ThreadId) =>
  Promise.all([
    queryClient.invalidateQueries({ queryKey: keys.messages(threadId) }),
    queryClient.invalidateQueries({
      exact: true,
      queryKey: keys.thread(threadId),
    }),
    queryClient.invalidateQueries({ queryKey: threadListsKey }),
  ]);

/** Open a conversation. It belongs to no Telegram chat, so it is reachable only by id. */
export const useCreateThread = () => {
  const queryClient = useQueryClient();
  return useMutation({
    ...apiMutation((payload: ThreadCreate, client) =>
      client.threads.create({ payload })
    ),
    onSuccess: () =>
      queryClient.invalidateQueries({ queryKey: threadListsKey }),
  });
};

/**
 * Retitle a conversation, make it the current one, or retire it. Currency moves
 * rather than being dropped, so every list is re-read: the thread that was
 * current a moment ago is no longer.
 */
export const usePatchThread = () => {
  const queryClient = useQueryClient();
  return useMutation({
    ...apiMutation((edit: ThreadEdit, client) =>
      client.threads.patch({
        params: { threadId: edit.threadId },
        payload: edit.patch,
      })
    ),
    onSuccess: (_thread, edit) =>
      Promise.all([
        queryClient.invalidateQueries({
          exact: true,
          queryKey: keys.thread(edit.threadId),
        }),
        queryClient.invalidateQueries({ queryKey: threadListsKey }),
      ]),
  });
};

/**
 * Say something to the manager.
 *
 * The answer says whether this message starts a turn or joins one already
 * running. A queued message is not held anywhere — the next turn reads it with
 * everything else that arrived, which is why several become one prompt — so a
 * caller that will not wait stops the live turn instead.
 */
export const usePostMessage = () => {
  const queryClient = useQueryClient();
  return useMutation({
    ...apiMutation((draft: MessageDraft, client) =>
      client.threads.postMessage({
        params: { threadId: draft.threadId },
        payload: { body: draft.body },
      })
    ),
    onSuccess: (_posted, draft) => settleThread(queryClient, draft.threadId),
  });
};

/**
 * Cut the live turn short so what has been said since is answered now.
 *
 * An intent on the orchestrator's queue, exactly as stopping a worker is: the
 * messages the stopped turn never read stay unread and the next turn resumes
 * with them.
 */
export const useStopThread = () => {
  const queryClient = useQueryClient();
  return useMutation({
    ...apiMutation((threadId: ThreadId, client) =>
      client.threads.stop({ params: { threadId }, payload: {} })
    ),
    onSuccess: async (_command, threadId) => {
      await Promise.all([
        settleThread(queryClient, threadId),
        queryClient.invalidateQueries({ queryKey: threadRunsKey(threadId) }),
      ]);
    },
  });
};
