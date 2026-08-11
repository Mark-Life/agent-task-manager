import { useQuery } from "@tanstack/react-query";
import type { ThreadId } from "@workspace/domain";
import { Badge } from "@workspace/ui/components/badge";
import {
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from "@workspace/ui/components/sheet";
import { Skeleton } from "@workspace/ui/components/skeleton";
import { Spinner } from "@workspace/ui/components/spinner";
import { threadQuery } from "@/api/threads";
import { Composer } from "@/features/chat/composer";
import { Transcript } from "@/features/chat/transcript";
import { formatRelative } from "@/lib/format";

/** How often the thread is re-read while a turn is being written. */
const LIVE_POLL_MS = 3000;

/** And while nothing is running: a turn can also be started from Telegram. */
const IDLE_POLL_MS = 15_000;

/**
 * One conversation, read live.
 *
 * The thread is polled rather than subscribed to, and faster while a turn is
 * running: the manager answers by writing a message when the turn ends, and the
 * same thread is spoken to from Telegram, so a panel that only refreshed on its
 * own sends would quietly go stale. Everything below reads the turn state from
 * here, so there is one answer to whether something is running.
 *
 * Its own module because the panel around it is on every authenticated screen
 * while this is on none of them until somebody opens one: the transcript brings
 * the markdown parser and the syntax highlighter with it, which is a large thing
 * to carry for a page that may never show a message.
 */
export const Conversation = ({ threadId }: { readonly threadId: ThreadId }) => {
  const detail = useQuery({
    ...threadQuery(threadId),
    refetchInterval: (query) => {
      const running = query.state.data?.liveRunId ?? null;
      return running === null ? IDLE_POLL_MS : LIVE_POLL_MS;
    },
  });

  const thread = detail.data?.thread;
  const isTurnRunning = (detail.data?.liveRunId ?? null) !== null;

  if (detail.isError) {
    return (
      <div className="flex flex-1 items-center justify-center p-6">
        <p className="text-muted-foreground text-xs">
          This conversation could not be read.
        </p>
      </div>
    );
  }

  return (
    <>
      <SheetHeader className="gap-1.5 border-border border-b p-4 pr-12">
        {thread === undefined ? (
          <Skeleton className="h-4 w-48" />
        ) : (
          <SheetTitle>{thread.title ?? "New conversation"}</SheetTitle>
        )}
        <SheetDescription className="flex items-center gap-2">
          {isTurnRunning ? (
            <>
              <Spinner className="size-3.5" />
              <span>Working</span>
            </>
          ) : null}
          {thread === undefined ? null : (
            <span>Last spoken in {formatRelative(thread.lastMessageAt)}</span>
          )}
          {thread?.status === "archived" ? (
            <Badge variant="outline">Archived</Badge>
          ) : null}
        </SheetDescription>
      </SheetHeader>
      <Transcript isTurnRunning={isTurnRunning} threadId={threadId} />
      <Composer isTurnRunning={isTurnRunning} threadId={threadId} />
    </>
  );
};
