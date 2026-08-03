import { useInfiniteQuery } from "@tanstack/react-query";
import type { ThreadMessage } from "@workspace/api";
import type { ThreadId } from "@workspace/domain";
import { Bubble, BubbleContent } from "@workspace/ui/components/bubble";
import {
  Empty,
  EmptyDescription,
  EmptyHeader,
  EmptyTitle,
} from "@workspace/ui/components/empty";
import { Marker, MarkerContent } from "@workspace/ui/components/marker";
import {
  Message,
  MessageContent,
  MessageHeader,
} from "@workspace/ui/components/message";
import {
  MessageScroller,
  MessageScrollerButton,
  MessageScrollerContent,
  MessageScrollerItem,
  MessageScrollerProvider,
  MessageScrollerViewport,
} from "@workspace/ui/components/message-scroller";
import { Skeleton } from "@workspace/ui/components/skeleton";
import { Spinner } from "@workspace/ui/components/spinner";
import { useEffect, useMemo } from "react";
import { threadMessagesQuery } from "@/api/threads";
import { formatAbsolute, formatRelative } from "@/lib/format";

/** How often the conversation is re-read while a turn is being written. */
const LIVE_POLL_MS = 3000;

/** And while nothing is running: slow enough to be free, quick enough to notice Telegram. */
const IDLE_POLL_MS = 15_000;

/** Who is speaking, in the terms the reader thinks in rather than the column's. */
const AUTHOR_LABELS = {
  manager: "Manager",
  user: "You",
} as const;

/** The day a message belongs to, in the reader's own zone. */
const dayOf = (message: ThreadMessage) =>
  formatAbsolute(message.createdAt, { timeStyle: undefined });

/**
 * Where a message came in from, when that is not the obvious answer.
 *
 * The same conversation is spoken to from Telegram and from here, so a line
 * whose origin is invisible reads as one the operator typed. A voice note is
 * called out separately: what is stored is a transcription, and knowing that
 * explains its phrasing.
 */
const sourceOf = (message: ThreadMessage) => {
  if (message.intakeKind === "voice") {
    return "voice note";
  }
  if (message.telegramMessageId !== null) {
    return "Telegram";
  }
  return null;
};

/**
 * The conversation, split into days.
 *
 * A divider belongs to the message that opens a day rather than to a list of
 * its own, so the rows stay one flat array and the scroller keeps one item per
 * message — which is what its anchoring counts.
 */
const withDayMarkers = (messages: readonly ThreadMessage[]) =>
  messages.map((message, index) => {
    const previous = messages[index - 1];
    const day = dayOf(message);
    if (previous === undefined || dayOf(previous) !== day) {
      return { day, message };
    }
    return { day: null, message };
  });

interface TranscriptProps {
  /** A turn is being written right now, which is polled for rather than streamed. */
  readonly isTurnRunning: boolean;
  readonly threadId: ThreadId;
}

/**
 * A conversation, opened on the last thing said.
 *
 * Nothing streams: the manager is invoked once per turn and its answer lands as
 * a message when the turn ends, so the honest live signal is a working line at
 * the foot of the transcript and a faster poll while it is there. The scroller
 * owns anchoring — it keeps the reader at the end unless they have scrolled
 * away, which is why nothing here touches scroll position.
 */
export const Transcript = ({ isTurnRunning, threadId }: TranscriptProps) => {
  const query = useInfiniteQuery({
    ...threadMessagesQuery(threadId),
    refetchInterval: isTurnRunning ? LIVE_POLL_MS : IDLE_POLL_MS,
  });
  const { data, fetchNextPage, hasNextPage, isFetchingNextPage } = query;

  const rows = useMemo(
    () => withDayMarkers(data?.pages.flatMap((page) => page.messages) ?? []),
    [data]
  );

  /**
   * Walk to the end of the conversation as soon as it is open.
   *
   * The cursor only runs forwards, so the newest message is behind however many
   * pages of history precede it and a reader left on page one would be looking
   * at the wrong end of the conversation. Walking also leaves the short tail page
   * as the last one cached, which is the page every poll re-reads — so an answer
   * written while the panel is open appears in it.
   */
  useEffect(() => {
    if (hasNextPage && !isFetchingNextPage) {
      fetchNextPage();
    }
  }, [fetchNextPage, hasNextPage, isFetchingNextPage]);

  return (
    <MessageScrollerProvider autoScroll defaultScrollPosition="end">
      <MessageScroller className="flex-1">
        <MessageScrollerViewport className="px-6 py-4">
          <MessageScrollerContent>
            {query.isPending ? <Skeleton className="h-24 w-full" /> : null}
            {rows.length === 0 && !query.isPending ? (
              <Empty className="border-0">
                <EmptyHeader>
                  <EmptyTitle>Nothing said yet</EmptyTitle>
                  <EmptyDescription>
                    Ask the manager for the board, or tell it what to pick up
                    next.
                  </EmptyDescription>
                </EmptyHeader>
              </Empty>
            ) : null}
            {rows.map((row) => (
              <MessageScrollerItem
                key={row.message.id}
                messageId={row.message.id}
              >
                {row.day === null ? null : (
                  <Marker className="pb-4" variant="separator">
                    <MarkerContent>{row.day}</MarkerContent>
                  </Marker>
                )}
                <MessageRow message={row.message} />
              </MessageScrollerItem>
            ))}
            {hasNextPage ? (
              <div className="flex justify-center py-2">
                <Spinner className="size-3.5" />
              </div>
            ) : null}
            {isTurnRunning ? (
              <MessageScrollerItem messageId="working">
                <Marker>
                  <Spinner className="size-3.5" />
                  <MarkerContent>
                    Working. The answer arrives when the turn ends.
                  </MarkerContent>
                </Marker>
              </MessageScrollerItem>
            ) : null}
          </MessageScrollerContent>
        </MessageScrollerViewport>
        <MessageScrollerButton direction="end" />
      </MessageScroller>
    </MessageScrollerProvider>
  );
};

/**
 * One thing that was said.
 *
 * The operator's own words sit right and accented, the manager's left and
 * quiet, which is the only cue a reader needs at a glance. Bodies are rendered
 * with their newlines intact: the manager answers in short paragraphs and
 * collapsing them turns a list of tasks into a sentence.
 */
const MessageRow = ({ message }: { readonly message: ThreadMessage }) => {
  const isOperator = message.role === "user";
  const source = sourceOf(message);

  return (
    <Message align={isOperator ? "end" : "start"}>
      <MessageContent>
        <MessageHeader className="gap-2">
          <span>{AUTHOR_LABELS[message.role]}</span>
          <span>{formatRelative(message.createdAt)}</span>
          {source === null ? null : <span>{source}</span>}
        </MessageHeader>
        <Bubble variant={isOperator ? "default" : "muted"}>
          <BubbleContent className="whitespace-pre-wrap">
            {message.body}
          </BubbleContent>
        </Bubble>
      </MessageContent>
    </Message>
  );
};
