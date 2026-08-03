import { SentIcon } from "@hugeicons/core-free-icons";
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
import {
  Empty,
  EmptyDescription,
  EmptyHeader,
  EmptyTitle,
} from "@workspace/ui/components/empty";
import { Skeleton } from "@workspace/ui/components/skeleton";
import { Textarea } from "@workspace/ui/components/textarea";
import { type ChangeEvent, useCallback, useState } from "react";
import { commentsQuery, useAppendComment } from "@/api/comments";
import { failureText } from "@/features/task/actions";
import { formatRelative } from "@/lib/format";

/** Enough of an id to recognise it again, and to tell two of them apart. */
const ID_PREFIX = 8;

const shortId = (id: string) => id.slice(0, ID_PREFIX);

/** Who is speaking, in the terms the reader thinks in rather than the column's. */
const AUTHOR_LABELS = {
  agent: "Agent",
  human: "Person",
  manager: "Manager",
  orchestrator: "Orchestrator",
} as const satisfies Record<CommentAuthorKind, string>;

/**
 * A task's conversation, and the box for adding to it.
 *
 * This is the only channel that crosses sessions, so every line carries who
 * said it and, for an agent, which session and run it came from — several
 * sessions on one task are otherwise one undifferentiated voice, and a reader
 * cannot tell the review from the implementation that it reviewed.
 */
export const TaskComments = ({ taskId }: { readonly taskId: TaskId }) => {
  const comments = useQuery(commentsQuery(taskId));

  return (
    <section className="flex flex-col gap-6">
      {comments.isPending ? <Skeleton className="h-20 w-full" /> : null}
      {comments.data?.length === 0 ? (
        <Empty>
          <EmptyHeader>
            <EmptyTitle>Nothing said yet</EmptyTitle>
            <EmptyDescription>
              A comment here is what the next session is given to read.
            </EmptyDescription>
          </EmptyHeader>
        </Empty>
      ) : null}
      <ol className="flex flex-col gap-5">
        {comments.data?.map((comment) => (
          <CommentRow comment={comment} key={comment.id} />
        ))}
      </ol>
      <Composer taskId={taskId} />
    </section>
  );
};

/**
 * One line of the conversation.
 *
 * An auto-appended closing message is folded away by default: it repeats what
 * the run already said and would otherwise be the loudest thing on the page. A
 * crash comment never folds, for the same reason in reverse — it is the one
 * comment nobody should have to click to find.
 */
const CommentRow = ({ comment }: { readonly comment: Comment }) => {
  const body =
    comment.kind === "run_error" ? (
      <p className="whitespace-pre-wrap text-destructive">{comment.body}</p>
    ) : (
      <p className="whitespace-pre-wrap">{comment.body}</p>
    );

  return (
    <li className="flex flex-col gap-1.5 text-xs">
      <Attribution comment={comment} />
      {comment.kind === "fallback" ? (
        <Collapsible>
          <CollapsibleTrigger render={<Button size="xs" variant="ghost" />}>
            Closing message
          </CollapsibleTrigger>
          <CollapsibleContent className="pt-1.5">{body}</CollapsibleContent>
        </Collapsible>
      ) : (
        body
      )}
    </li>
  );
};

/**
 * Who spoke, and from where. The session and the run are shown by their first
 * few characters, which is enough to match a comment to the attempt further
 * down the page without turning every line into a pair of uuids.
 */
const Attribution = ({ comment }: { readonly comment: Comment }) => (
  <div className="flex flex-wrap items-center gap-2 text-muted-foreground">
    <span className="font-medium text-foreground">
      {AUTHOR_LABELS[comment.authorKind]}
    </span>
    {comment.agentSessionId === null ? null : (
      <span title={comment.agentSessionId}>
        session {shortId(comment.agentSessionId)}
      </span>
    )}
    {comment.runId === null ? null : (
      <span title={comment.runId}>run {shortId(comment.runId)}</span>
    )}
    {comment.kind === "run_error" ? (
      <span className="text-destructive">crashed</span>
    ) : null}
    <span>{formatRelative(comment.createdAt)}</span>
  </div>
);

/**
 * Saying something on the task.
 *
 * The author is never sent: the server takes it off the credential, so nothing
 * typed here can be signed as somebody else. The box empties only once the
 * write has landed, which is what keeps a failed send from losing what was
 * written.
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

  return (
    <div className="flex flex-col gap-2">
      <Textarea
        onChange={onChange}
        placeholder="Add something the next session should read."
        rows={3}
        value={body}
      />
      {failureText(append.error) === null ? null : (
        <p className="text-destructive text-xs">{failureText(append.error)}</p>
      )}
      <div className="flex justify-end">
        <Button
          disabled={append.isPending || body.trim() === ""}
          onClick={send}
        >
          <HugeiconsIcon icon={SentIcon} strokeWidth={2} />
          Comment
        </Button>
      </div>
    </div>
  );
};
