import { useQuery } from "@tanstack/react-query";
import type { ThreadId } from "@workspace/domain";
import { Badge } from "@workspace/ui/components/badge";
import {
  Sheet,
  SheetContent,
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

interface ChatOverlayProps {
  /** Called with `false` when the panel closes; the layout drops the search param. */
  readonly onOpenChange: (open: boolean) => void;
  /** The conversation to show, or null for no overlay at all. */
  readonly threadId: ThreadId | null;
}

/**
 * A conversation with the manager, over whatever is on screen.
 *
 * A side panel rather than a centred dialog: a conversation is read top to
 * bottom and needs the full height of the window, and the screen underneath
 * stays mounted behind it rather than being navigated away from, so closing the
 * panel puts the reader back where they were. Opening and closing are the
 * caller's, so the panel's visibility is a fact about the URL and a link to one
 * conversation can be sent to someone.
 *
 * The width is spelled as `data-[side=right]:` variants because the primitive
 * caps a right-hand panel with variants of its own, which a plainer class loses
 * to. The name sits on the panel rather than only in its header: the header's
 * title arrives with the thread, and the dialog is announced before that.
 */
export const ChatOverlay = ({ onOpenChange, threadId }: ChatOverlayProps) => (
  <Sheet onOpenChange={onOpenChange} open={threadId !== null}>
    <SheetContent
      aria-label="Conversation"
      className="gap-0 p-0 data-[side=right]:w-full data-[side=right]:sm:max-w-xl data-[side=right]:lg:max-w-2xl"
      side="right"
    >
      {threadId === null ? null : <Conversation threadId={threadId} />}
    </SheetContent>
  </Sheet>
);

/**
 * One conversation, read live.
 *
 * The thread is polled rather than subscribed to, and faster while a turn is
 * running: the manager answers by writing a message when the turn ends, and the
 * same thread is spoken to from Telegram, so a panel that only refreshed on its
 * own sends would quietly go stale. Everything below reads the turn state from
 * here, so there is one answer to whether something is running.
 */
const Conversation = ({ threadId }: { readonly threadId: ThreadId }) => {
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
