import {
  Comment01Icon,
  Layers01Icon,
  Robot01Icon,
  SparklesIcon,
  User03Icon,
} from "@hugeicons/core-free-icons";
import type { IconSvgElement } from "@hugeicons/react";
import { HugeiconsIcon } from "@hugeicons/react";
import { useQuery } from "@tanstack/react-query";
import type { Comment } from "@workspace/api";
import type { CommentAuthorKind, TaskId } from "@workspace/domain";
import { Bubble, BubbleContent } from "@workspace/ui/components/bubble";
import { Button } from "@workspace/ui/components/button";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@workspace/ui/components/collapsible";
import { Markdown } from "@workspace/ui/components/markdown";
import { Marker, MarkerContent } from "@workspace/ui/components/marker";
import {
  Message,
  MessageAvatar,
  MessageContent,
  MessageFooter,
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
import { useMemo } from "react";
import { commentsQuery, useAppendComment } from "@/api/comments";
import {
  type ComposerSend,
  MessageComposer,
} from "@/features/messaging/composer";
import { withDayMarkers } from "@/features/messaging/days";
import { failureText } from "@/lib/failure";
import { formatRelative } from "@/lib/format";

/** Enough of an id to recognise it again, and to tell two of them apart. */
const ID_PREFIX = 8;

const shortId = (id: string) => id.slice(0, ID_PREFIX);

/** How a voice is drawn: as a turn in the conversation, or as a note about it. */
type Placement = "operator" | "speaker" | "system";

interface Author {
  readonly icon: IconSvgElement;
  readonly label: string;
  readonly placement: Placement;
}

/**
 * Who is speaking, in the terms the reader thinks in rather than the column's.
 *
 * Four voices share one thread and they are not four of the same thing. The
 * person is the one holding the conversation, so they sit where a reader's own
 * words sit. The agent and the manager are both answering — the manager because
 * an instruction is often dictated through it, at whatever length that takes —
 * so both sit opposite, told apart by their mark and their name rather than by
 * a side. The orchestrator is machinery: it reports that a run started or
 * stopped, which is a note about the conversation rather than a turn in it, and
 * it goes down the middle like a date.
 *
 * When a comment carries a specific agent or a named person, the label is the
 * only thing that has to change.
 */
const AUTHORS = {
  agent: { icon: Robot01Icon, label: "Agent", placement: "speaker" },
  human: { icon: User03Icon, label: "You", placement: "operator" },
  manager: { icon: SparklesIcon, label: "Manager", placement: "speaker" },
  orchestrator: {
    icon: Layers01Icon,
    label: "Orchestrator",
    placement: "system",
  },
} as const satisfies Record<CommentAuthorKind, Author>;

/**
 * The surface a comment is drawn on.
 *
 * A crash is destructive whoever reported it: it is usually the reason the
 * panel was opened, and it must not have to be told apart from an ordinary
 * report by reading it. Otherwise the operator's own words are accented and
 * everyone else's are quiet, which is the only cue a reader needs at a glance.
 */
const bubbleVariant = (comment: Comment, placement: Placement) => {
  if (comment.kind === "run_error") {
    return "destructive" as const;
  }
  return placement === "operator" ? ("default" as const) : ("muted" as const);
};

/**
 * The conversation on a task, and the box for adding to it.
 *
 * This is the only channel that crosses sessions, so every line carries who
 * said it and, for an agent, which session and run it came from — several
 * sessions on one task are otherwise one undifferentiated voice, and a reader
 * cannot tell the review from the implementation that it reviewed.
 *
 * Bodies are markdown because that is what agents write: a report arrives with
 * headings and a list of files, and shown verbatim it reads as punctuation
 * around the sentences. The operator's own text is left alone — somebody typing
 * an asterisk meant an asterisk.
 *
 * The scroller owns anchoring — it keeps the reader at the end unless they have
 * scrolled away — which is why nothing here touches scroll position.
 */
export const TaskMessages = ({ taskId }: { readonly taskId: TaskId }) => {
  const comments = useQuery(commentsQuery(taskId));
  const rows = useMemo(
    () => withDayMarkers(comments.data ?? []),
    [comments.data]
  );

  return (
    <div className="flex min-h-0 min-w-0 flex-1 flex-col">
      <MessageScrollerProvider autoScroll defaultScrollPosition="end">
        <MessageScroller className="min-w-0 flex-1">
          <MessageScrollerViewport className="py-4">
            <MessageScrollerContent className="gap-5">
              {comments.isPending ? <Skeleton className="h-24 w-full" /> : null}
              {comments.data?.length === 0 ? <NothingSaid /> : null}
              {rows.map((row) => (
                <MessageScrollerItem key={row.item.id} messageId={row.item.id}>
                  {row.day === null ? null : (
                    <Marker className="pb-4" variant="separator">
                      <MarkerContent>{row.day}</MarkerContent>
                    </Marker>
                  )}
                  <CommentRow comment={row.item} />
                </MessageScrollerItem>
              ))}
            </MessageScrollerContent>
          </MessageScrollerViewport>
          <MessageScrollerButton direction="end" />
        </MessageScroller>
      </MessageScrollerProvider>
      <TaskComposer taskId={taskId} />
    </div>
  );
};

/**
 * An empty conversation.
 *
 * A mark and one line, on the panel itself. The framed empty state the other
 * tabs use would draw a second surface inside a panel that is already one, and
 * a sentence explaining what a conversation is for is a sentence nobody reads —
 * what this panel is is answered by the tab it sits behind and by the box at the
 * foot of it.
 */
const NothingSaid = () => (
  <div className="flex flex-1 flex-col items-center justify-center gap-2 py-10 text-muted-foreground">
    <HugeiconsIcon
      className="size-5 opacity-60"
      icon={Comment01Icon}
      strokeWidth={2}
    />
    <p className="text-xs">Nothing said yet</p>
  </div>
);

/**
 * One turn of the conversation.
 *
 * An auto-appended closing message is folded away by default: it repeats what
 * the run already said and would otherwise be the loudest thing on the panel.
 * A crash never folds, for the same reason in reverse.
 */
const CommentRow = ({ comment }: { readonly comment: Comment }) => {
  const author = AUTHORS[comment.authorKind];

  if (author.placement === "system") {
    return <SystemRow author={author} comment={comment} />;
  }

  const operator = author.placement === "operator";

  return (
    <Message align={operator ? "end" : "start"}>
      <MessageAvatar className="size-7 min-w-7 text-muted-foreground">
        <HugeiconsIcon
          className="size-3.5"
          icon={author.icon}
          strokeWidth={2}
        />
      </MessageAvatar>
      <MessageContent>
        <MessageHeader className="gap-2">
          <span>{author.label}</span>
          <span>{formatRelative(comment.createdAt)}</span>
          {comment.kind === "run_error" ? (
            <span className="text-destructive">crashed</span>
          ) : null}
        </MessageHeader>
        <Bubble variant={bubbleVariant(comment, author.placement)}>
          <BubbleContent className="px-3 py-2 text-[0.8125rem]/relaxed">
            {comment.kind === "fallback" ? (
              <FoldedBody body={comment.body} />
            ) : (
              <Body body={comment.body} plain={operator} />
            )}
          </BubbleContent>
        </Bubble>
        <Provenance comment={comment} />
      </MessageContent>
    </Message>
  );
};

/**
 * A note about the conversation rather than a turn in it: a run was claimed, a
 * run gave up. Centred like a date, and never a bubble — nobody replies to it.
 */
const SystemRow = ({
  author,
  comment,
}: {
  readonly author: Author;
  readonly comment: Comment;
}) => (
  <Marker
    className={comment.kind === "run_error" ? "text-destructive" : undefined}
  >
    <HugeiconsIcon icon={author.icon} strokeWidth={2} />
    <MarkerContent>{comment.body}</MarkerContent>
    <span className="shrink-0">{formatRelative(comment.createdAt)}</span>
  </Marker>
);

/**
 * A body, as the thing it says.
 *
 * `plain` is for text a person typed: markdown would eat the asterisks and
 * underscores they meant literally, and nobody writing a two-line instruction
 * into a task expects a heading.
 */
const Body = ({
  body,
  plain,
}: {
  readonly body: string;
  readonly plain: boolean;
}) =>
  plain ? (
    <p className="whitespace-pre-wrap">{body}</p>
  ) : (
    <Markdown>{body}</Markdown>
  );

/** The closing message, out of the way until somebody wants it. */
const FoldedBody = ({ body }: { readonly body: string }) => (
  <Collapsible>
    <CollapsibleTrigger
      render={
        <Button
          className="-mx-1 h-6 text-muted-foreground"
          size="xs"
          variant="ghost"
        />
      }
    >
      Closing message
    </CollapsibleTrigger>
    <CollapsibleContent className="pt-1.5">
      <Markdown>{body}</Markdown>
    </CollapsibleContent>
  </Collapsible>
);

/**
 * Which attempt this came from, by the first few characters of its session and
 * run — enough to match a message to a row on the Runs tab without turning
 * every line into a pair of uuids. Nothing at all for a message a person typed.
 */
const Provenance = ({ comment }: { readonly comment: Comment }) => {
  if (comment.agentSessionId === null && comment.runId === null) {
    return null;
  }

  return (
    <MessageFooter className="gap-2 font-mono">
      {comment.agentSessionId === null ? null : (
        <span title={comment.agentSessionId}>
          session {shortId(comment.agentSessionId)}
        </span>
      )}
      {comment.runId === null ? null : (
        <span title={comment.runId}>run {shortId(comment.runId)}</span>
      )}
    </MessageFooter>
  );
};

/**
 * Saying something on the task.
 *
 * The author is never sent: the server takes it off the credential, so nothing
 * typed here can be signed as somebody else.
 */
const TaskComposer = ({ taskId }: { readonly taskId: TaskId }) => {
  const append = useAppendComment();
  const { mutate } = append;

  const send = useMemo(
    () =>
      ({ body, sent }: ComposerSend) => {
        mutate({ comment: { body }, taskId }, { onSuccess: sent });
      },
    [mutate, taskId]
  );

  return (
    // A box of its own now that the panel around it has no frame: without an
    // edge to sit against, a bar with one top border reads as an unfinished
    // rule across the sheet rather than as the thing to type into.
    <MessageComposer
      className="mb-1 overflow-hidden rounded-xl border"
      error={failureText(append.error)}
      isPending={append.isPending}
      onSend={send}
      placeholder="Say something the next session should read"
    />
  );
};
