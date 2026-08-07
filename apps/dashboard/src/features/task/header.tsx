import {
  Cancel01Icon,
  Delete02Icon,
  LinkSquare02Icon,
} from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import type { TaskDetail } from "@workspace/api";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from "@workspace/ui/components/alert-dialog";
import { Badge } from "@workspace/ui/components/badge";
import { Button } from "@workspace/ui/components/button";
import { Spinner } from "@workspace/ui/components/spinner";
import { useCallback } from "react";
import { useDeleteTask, usePatchTask } from "@/api/tasks";
import { InlineText } from "@/features/task/inline";
import { failureText } from "@/lib/failure";
import { formatRelative } from "@/lib/format";

interface TaskHeaderProps {
  readonly detail: TaskDetail;
  /**
   * Draws a close button at the end of the action row. Set by the overlay,
   * which drops the sheet's own floating close so it does not sit on top of
   * these buttons; the page keeps its URL instead.
   */
  readonly onClose?: () => void;
  /** Where to go once the task is gone — the page it was on no longer resolves. */
  readonly onDeleted?: () => void;
}

/**
 * What the task is, in one line — edited in place, like everything else on
 * this body — and the handful of verbs that are about the record rather than
 * the work: open its pull request, delete it.
 *
 * The column and the project the task sits in are not repeated here. They are
 * controls now rather than labels — the property rows below — and a badge
 * beside them would be the same fact twice, one of them not clickable.
 *
 * A task sitting in progress with no live run is drawn as waiting rather than
 * running, because those are different situations for the reader — one is an
 * agent working and the other is a queue or a stall — and a spinner on both
 * would hide the difference.
 */
export const TaskHeader = ({ detail, onClose, onDeleted }: TaskHeaderProps) => {
  const { liveRunId, task } = detail;

  return (
    <header className="flex flex-col gap-1.5">
      <div className="flex items-start justify-between gap-6">
        <h1 className="min-w-0 flex-1 font-heading font-medium text-lg leading-snug">
          <TaskTitle task={task} />
        </h1>
        <div className="flex shrink-0 items-center gap-1">
          {task.prUrl === null ? null : (
            <Button
              // A link that looks like a button is still a link, and saying so
              // keeps the anchor's own semantics — open in a new tab, copy the
              // address — instead of having button behaviour bolted over them.
              nativeButton={false}
              render={
                <a
                  href={task.prUrl}
                  rel="noreferrer"
                  target="_blank"
                  title={task.prUrl}
                />
              }
              size="sm"
              variant="outline"
            >
              <HugeiconsIcon icon={LinkSquare02Icon} strokeWidth={2} />
              Pull request
            </Button>
          )}
          <DeleteTask onDeleted={onDeleted} task={task} />
          {onClose === undefined ? null : (
            <Button
              aria-label="Close panel"
              onClick={onClose}
              size="icon-sm"
              variant="ghost"
            >
              <HugeiconsIcon icon={Cancel01Icon} strokeWidth={2} />
            </Button>
          )}
        </div>
      </div>

      <div className="flex flex-wrap items-center gap-2 text-muted-foreground text-xs">
        <span>moved here {formatRelative(task.statusChangedAt)}</span>
        {liveRunId === null ? null : (
          <span className="flex items-center gap-1.5 text-foreground">
            <Spinner className="size-3" />
            running
          </span>
        )}
        {liveRunId === null && task.status === "in_progress" ? (
          <span>waiting for a worker slot</span>
        ) : null}
        {task.parkedUntil === null ? null : (
          <Badge variant="destructive">
            parked until {formatRelative(task.parkedUntil)}
          </Badge>
        )}
      </div>
    </header>
  );
};

/**
 * The title, edited where it is read. The one field with no neutral state — a
 * task is not allowed to be nameless — so an emptied box reverts rather than
 * erasing, which the input enforces by refusing to commit an empty string.
 */
const TaskTitle = ({ task }: { readonly task: TaskDetail["task"] }) => {
  const patch = usePatchTask();
  const { mutate } = patch;

  const commit = useCallback(
    (next: string) => mutate({ patch: { title: next }, taskId: task.id }),
    [mutate, task.id]
  );

  const failed = failureText(patch.error);

  return (
    <span className="flex flex-col gap-1">
      <InlineText
        allowEmpty={false}
        editLabel="Edit title"
        emptyText="Untitled"
        onCommit={commit}
        value={task.title}
      />
      {failed === null ? null : (
        <span className="font-normal font-sans text-destructive text-xs">
          {failed}
        </span>
      )}
    </span>
  );
};

interface DeleteTaskProps {
  readonly onDeleted?: () => void;
  readonly task: TaskDetail["task"];
}

/**
 * Deletion behind a confirmation, because it takes the task's comments,
 * sessions, runs and artifacts with it — the evidence of what happened, not
 * just the card. The dialog says so rather than asking "are you sure", which
 * tells a reader nothing they did not already know.
 */
const DeleteTask = ({ onDeleted, task }: DeleteTaskProps) => {
  const remove = useDeleteTask();
  const { mutate } = remove;

  const confirm = useCallback(() => {
    mutate(task.id, { onSuccess: onDeleted });
  }, [mutate, onDeleted, task.id]);

  return (
    <AlertDialog>
      <AlertDialogTrigger
        render={
          <Button aria-label="Delete task" size="icon-sm" variant="ghost" />
        }
      >
        <HugeiconsIcon icon={Delete02Icon} strokeWidth={2} />
      </AlertDialogTrigger>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>Delete “{task.title}”?</AlertDialogTitle>
          <AlertDialogDescription>
            Its comments, sessions, runs and artifacts go with it. There is no
            undo.
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel>Keep</AlertDialogCancel>
          <AlertDialogAction
            disabled={remove.isPending}
            onClick={confirm}
            variant="destructive"
          >
            Delete
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
};
