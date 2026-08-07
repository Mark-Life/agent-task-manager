import {
  Comment01Icon,
  Layers01Icon,
  Robot01Icon,
  SentIcon,
  SparklesIcon,
  User03Icon,
} from "@hugeicons/core-free-icons";
import type { IconSvgElement } from "@hugeicons/react";
import { HugeiconsIcon } from "@hugeicons/react";
import { useQuery } from "@tanstack/react-query";
import type { Comment } from "@workspace/api";
import type { CommentAuthorKind, TaskId } from "@workspace/domain";
import { Button } from "@workspace/ui/components/button";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@workspace/ui/components/collapsible";
import { Kbd, KbdGroup } from "@workspace/ui/components/kbd";
import { Textarea } from "@workspace/ui/components/textarea";
import { cn } from "@workspace/ui/lib/utils";
import {
  type ChangeEvent,
  type KeyboardEvent,
  useCallback,
  useState,
} from "react";
import { commentsQuery, useAppendComment } from "@/api/comments";
import { EmptyState } from "@/components/empty-state";
import { Pending } from "@/components/query-state";
import { failureText } from "@/lib/failure";
import { formatRelative } from "@/lib/format";

/** Enough of an id to recognise it again, and to tell two of them apart. */
const ID_PREFIX = 8;

const shortId = (id: string) => id.slice(0, ID_PREFIX);

/**
 * Who is speaking, in the terms the reader thinks in rather than the column's,
 * and the mark that says it before the name is read. Four voices share one
 * thread, and the difference between an agent's report and a person's
 * instruction is the thing a reader scans for.
 */
const AUTHORS = {
  agent: { icon: Robot01Icon, label: "Agent" },
  human: { icon: User03Icon, label: "Person" },
  manager: { icon: SparklesIcon, label: "Manager" },
  orchestrator: { icon: Layers01Icon, label: "Orchestrator" },
} as const satisfies Record<
  CommentAuthorKind,
  { icon: IconSvgElement; label: string }
>;

/**
 * A task's conversation, and the box for adding to it.
 *
 * This is the only channel that crosses sessions, so every line carries who
 * said it and, for an agent, which session and run it came from — several
 * sessions on one task are otherwise one undifferentiated voice, and a reader
 * cannot tell the review from the implementation that it reviewed.
 *
 * It is laid out as a conversation rather than as a log: a mark for the
 * speaker, their name at the size of the text, and the body in the size
 * anything meant to be read is written in. The box stays under the thread in
 * every state, including the empty one — an empty conversation is exactly when
 * somebody wants to start it.
 */
export const TaskComments = ({ taskId }: { readonly taskId: TaskId }) => {
  const comments = useQuery(commentsQuery(taskId));

  return (
    <section className="flex flex-col gap-5">
      {comments.isPending ? (
        <Pending label="Loading comments" lines={3} />
      ) : null}
      {comments.data?.length === 0 ? (
        <EmptyState
          description="A comment here is what the next session is given to read."
          icon={Comment01Icon}
          title="Nothing said yet"
        />
      ) : null}
      {comments.data === undefined || comments.data.length === 0 ? null : (
        <ol className="flex flex-col gap-4">
          {comments.data.map((comment) => (
            <CommentRow comment={comment} key={comment.id} />
          ))}
        </ol>
      )}
      <Composer taskId={taskId} />
    </section>
  );
};

/**
 * One turn of the conversation.
 *
 * An auto-appended closing message is folded away by default: it repeats what
 * the run already said and would otherwise be the loudest thing on the page. A
 * crash comment never folds and carries the panel's only tinted frame, for the
 * same reason in reverse — it is the one comment nobody should have to click to
 * find, and usually the reason the tab was opened.
 */
const CommentRow = ({ comment }: { readonly comment: Comment }) => {
  const crashed = comment.kind === "run_error";
  const author = AUTHORS[comment.authorKind];

  const body = (
    <p
      className={cn(
        "whitespace-pre-wrap text-sm/relaxed",
        crashed && "text-destructive"
      )}
    >
      {comment.body}
    </p>
  );

  return (
    <li
      className={cn(
        "flex gap-3",
        crashed &&
          "rounded-lg border border-destructive/30 bg-destructive/5 p-3"
      )}
    >
      <span
        aria-hidden="true"
        className={cn(
          "mt-0.5 flex size-6 shrink-0 items-center justify-center rounded-full bg-muted text-muted-foreground",
          crashed && "bg-destructive/10 text-destructive"
        )}
      >
        <HugeiconsIcon
          className="size-3.5"
          icon={author.icon}
          strokeWidth={2}
        />
      </span>
      <div className="flex min-w-0 flex-1 flex-col gap-1">
        <Attribution comment={comment} label={author.label} />
        {comment.kind === "fallback" ? (
          <Collapsible>
            <CollapsibleTrigger
              render={
                <Button
                  className="-ml-2 text-muted-foreground"
                  size="xs"
                  variant="ghost"
                />
              }
            >
              Closing message
            </CollapsibleTrigger>
            <CollapsibleContent className="pt-1.5">{body}</CollapsibleContent>
          </Collapsible>
        ) : (
          body
        )}
      </div>
    </li>
  );
};

/**
 * Who spoke, and from where. The name and the time carry the line; the session
 * and the run trail behind it in the smaller type, shown by their first few
 * characters, which is enough to match a comment to the attempt on the Runs tab
 * without turning every line into a pair of uuids.
 */
const Attribution = ({
  comment,
  label,
}: {
  readonly comment: Comment;
  readonly label: string;
}) => (
  <div className="flex flex-wrap items-baseline gap-x-2 gap-y-0.5">
    <span className="font-medium text-sm">{label}</span>
    <span className="text-muted-foreground text-xs">
      {formatRelative(comment.createdAt)}
    </span>
    {comment.kind === "run_error" ? (
      <span className="font-medium text-destructive text-xs">crashed</span>
    ) : null}
    {comment.agentSessionId === null ? null : (
      <span
        className="font-mono text-[0.625rem] text-muted-foreground"
        title={comment.agentSessionId}
      >
        session {shortId(comment.agentSessionId)}
      </span>
    )}
    {comment.runId === null ? null : (
      <span
        className="font-mono text-[0.625rem] text-muted-foreground"
        title={comment.runId}
      >
        run {shortId(comment.runId)}
      </span>
    )}
  </div>
);

/**
 * Saying something on the task.
 *
 * The author is never sent: the server takes it off the credential, so nothing
 * typed here can be signed as somebody else. The box empties only once the
 * write has landed, which is what keeps a failed send from losing what was
 * written.
 *
 * Cmd/Ctrl+Enter sends, and the box says so rather than leaving it to be
 * guessed — a comment is usually two lines typed between two other things, and
 * reaching for the mouse to post them is the tax on doing it at all. Plain
 * Enter stays a newline, because the alternative is posting half a sentence.
 */
const Composer = ({ taskId }: { readonly taskId: TaskId }) => {
  const [body, setBody] = useState("");
  const append = useAppendComment();
  const { mutate } = append;

  const onChange = useCallback((event: ChangeEvent<HTMLTextAreaElement>) => {
    setBody(event.target.value);
  }, []);

  const clear = useCallback(() => setBody(""), []);

  const send = useCallback(() => {
    const text = body.trim();
    if (text === "") {
      return;
    }
    mutate({ comment: { body: text }, taskId }, { onSuccess: clear });
  }, [body, clear, mutate, taskId]);

  const onKeyDown = useCallback(
    (event: KeyboardEvent<HTMLTextAreaElement>) => {
      if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) {
        event.preventDefault();
        send();
      }
    },
    [send]
  );

  const failed = failureText(append.error);

  return (
    <div className="flex flex-col gap-2">
      <div className="rounded-lg border border-input bg-input/20 focus-within:border-ring focus-within:ring-2 focus-within:ring-ring/30 dark:bg-input/30">
        <Textarea
          className="min-h-14 border-0 bg-transparent focus-visible:border-0 focus-visible:ring-0 md:text-sm dark:bg-transparent"
          onChange={onChange}
          onKeyDown={onKeyDown}
          placeholder="Add something the next session should read."
          rows={2}
          value={body}
        />
        <div className="flex items-center justify-between gap-2 border-input border-t px-2 py-1.5">
          <KbdGroup className="text-[0.625rem] text-muted-foreground">
            <Kbd>⌘</Kbd>
            <Kbd>↵</Kbd>
            <span>to send</span>
          </KbdGroup>
          <Button
            disabled={append.isPending || body.trim() === ""}
            onClick={send}
            size="sm"
          >
            <HugeiconsIcon icon={SentIcon} strokeWidth={2} />
            Comment
          </Button>
        </div>
      </div>
      {failed === null ? null : (
        <p className="text-destructive text-xs">{failed}</p>
      )}
    </div>
  );
};
