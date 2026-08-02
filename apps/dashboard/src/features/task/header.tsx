import {
  Delete02Icon,
  LinkSquare02Icon,
  PencilEdit01Icon,
} from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import type { TaskDetail } from "@workspace/api";
import type { TaskStatus } from "@workspace/domain";
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
import { type ComponentProps, useCallback, useState } from "react";
import { useDeleteTask } from "@/api/tasks";
import { STATUS_LABELS } from "@/features/task/task-fields";
import { TaskFormDialog } from "@/features/task/task-form";
import { formatRelative } from "@/lib/format";

/**
 * One accent carries the column that is spending a worker slot; everything else
 * is quiet. A board of five equally loud badges tells a reader nothing about
 * where their attention belongs.
 */
const STATUS_VARIANTS = {
  backlog: "outline",
  done: "outline",
  ideas: "outline",
  in_progress: "default",
  review: "secondary",
} as const satisfies Record<
  TaskStatus,
  ComponentProps<typeof Badge>["variant"]
>;

interface TaskHeaderProps {
  readonly detail: TaskDetail;
  /** Where to go once the task is gone — the page it was on no longer resolves. */
  readonly onDeleted?: () => void;
}

/**
 * What the task is, in one line, and the handful of verbs that are about the
 * record rather than the work: open its pull request, edit it, delete it.
 *
 * A task sitting in progress with no live run is drawn as waiting rather than
 * running, because those are different situations for the reader — one is an
 * agent working and the other is a queue or a stall — and a spinner on both
 * would hide the difference.
 */
export const TaskHeader = ({ detail, onDeleted }: TaskHeaderProps) => {
  const [editing, setEditing] = useState(false);
  const openEditor = useCallback(() => setEditing(true), []);
  const { liveRunId, project, task } = detail;

  return (
    <header className="flex flex-col gap-3">
      <div className="flex items-start justify-between gap-6">
        <h1 className="font-heading font-medium text-base leading-snug">
          {task.title}
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
          <Button
            aria-label="Edit task"
            onClick={openEditor}
            size="icon-sm"
            variant="ghost"
          >
            <HugeiconsIcon icon={PencilEdit01Icon} strokeWidth={2} />
          </Button>
          <DeleteTask onDeleted={onDeleted} task={task} />
        </div>
      </div>

      <div className="flex flex-wrap items-center gap-2 text-muted-foreground text-xs">
        <Badge variant={STATUS_VARIANTS[task.status]}>
          {STATUS_LABELS[task.status]}
        </Badge>
        {project === null ? null : <span>{project.name}</span>}
        <span>here {formatRelative(task.statusChangedAt)}</span>
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

      <TaskFormDialog onOpenChange={setEditing} open={editing} task={task} />
    </header>
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
