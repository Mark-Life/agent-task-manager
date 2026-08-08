import { Cancel01Icon, LinkSquare02Icon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import type { TaskDetail } from "@workspace/api";
import { Badge } from "@workspace/ui/components/badge";
import { Button } from "@workspace/ui/components/button";
import { Spinner } from "@workspace/ui/components/spinner";
import { useCallback } from "react";
import { usePatchTask } from "@/api/tasks";
import { CopyButton } from "@/components/copy-button";
import { InlineText } from "@/features/task/inline";
import { StatusSelect } from "@/features/task/status-select";
import { failureText } from "@/lib/failure";
import { formatRelative } from "@/lib/format";
import { taskUrl } from "@/lib/url";

interface TaskHeaderProps {
  readonly detail: TaskDetail;
  /**
   * Draws a close button at the end of the action row. Set by the overlay,
   * which drops the sheet's own floating close so it does not sit on top of
   * these buttons; the page keeps its URL instead.
   */
  readonly onClose?: () => void;
}

/**
 * What the task is and where it sits, above whatever panel is open.
 *
 * Two lines: the name, edited in place like everything else on this body, and
 * the column it is filed in as the control that moves it. The status is here
 * rather than down among the property rows because it is the one field a reader
 * both checks at a glance and changes most often, and the panel below it can be
 * showing anything.
 *
 * The pull request chip sits at the end of that second line rather than beside
 * the title. A title is as long as somebody made it, and on a phone a chip
 * sharing its row squeezes it into a column of two-word lines; on the status
 * row it has the whole width to the right of a fixed-width control.
 *
 * What stays beside the title is the action group: the ways out of the panel
 * and the one way to take the task somewhere else — a copy of its address,
 * which is how a person hands this exact task to the manager agent in chat.
 *
 * Deletion is not in this row. It used to sit a few pixels from the close
 * button, where a missed tap on a phone deleted the task instead of shutting
 * the panel; it lives at the foot of the Details panel now, which costs a
 * deliberate visit to reach.
 *
 * A task sitting in progress with no live run is drawn as waiting rather than
 * running, because those are different situations for the reader — one is an
 * agent working and the other is a queue or a stall — and a spinner on both
 * would hide the difference.
 */
export const TaskHeader = ({ detail, onClose }: TaskHeaderProps) => {
  const { liveRunId, task } = detail;

  return (
    <header className="flex flex-col gap-2">
      <div className="flex items-start justify-between gap-4">
        <h1 className="min-w-0 flex-1 font-heading font-medium text-lg leading-snug">
          <TaskTitle task={task} />
        </h1>
        <div className="flex shrink-0 items-center gap-1">
          {/*
            The address of this task, for pasting into a message to the manager
            agent: a title drifts when it is edited and reads the same as the
            next card, an id resolves to exactly one task. Icon-only and ghost
            so it stays quiet next to the close button, and sized to match it
            because both are hit with a thumb.
          */}
          <CopyButton
            label="Copy link to this task"
            size="icon-lg"
            value={taskUrl(task.id)}
          />
          {onClose === undefined ? null : (
            // The one target on this panel every reader hits, and on a phone it
            // is hit with a thumb: sized up now that nothing destructive sits
            // beside it to be caught by a miss.
            <Button
              aria-label="Close panel"
              onClick={onClose}
              size="icon-lg"
              variant="ghost"
            >
              <HugeiconsIcon icon={Cancel01Icon} strokeWidth={2} />
            </Button>
          )}
        </div>
      </div>

      <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5 text-muted-foreground text-xs">
        {/* The trigger fills whatever it is given, so it is given a width here
            rather than being allowed to take the row and push what follows it
            onto a second line. */}
        <div className="w-36 shrink-0">
          <StatusSelect task={task} />
        </div>
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
        {task.prUrl === null ? null : (
          <Button
            // Pushed to the end with a margin rather than by justifying the
            // row: the state words belong beside the status control, and
            // `justify-between` would strand them in the middle. When the row
            // wraps on a narrow screen the margin still lands the chip on the
            // right of whatever line it ends up on.
            className="ml-auto"
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
