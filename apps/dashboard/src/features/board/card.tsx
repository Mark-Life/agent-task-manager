import { useSortable } from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import { GitPullRequestIcon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import type { Task } from "@workspace/api";
import type { ProjectId, TaskId } from "@workspace/domain";
import { Badge } from "@workspace/ui/components/badge";
import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
} from "@workspace/ui/components/card";
import { Spinner } from "@workspace/ui/components/spinner";
import { cn } from "@workspace/ui/lib/utils";
import { DateTime } from "effect";
import { type MouseEvent as ReactMouseEvent, useCallback } from "react";
import { formatAbsolute } from "@/lib/format";

/** What a card knows about itself, plus the two things only the board can tell it. */
interface CardProps {
  /** Whether a run is working on this task right now. */
  readonly live: boolean;
  readonly onOpen: (taskId: TaskId) => void;
  /**
   * The workspace's projects by id. A card carries its project's name and the
   * board's own read carries only the id, so the lookup happens here rather
   * than being resolved five times over on the way down.
   */
  readonly projectNames: ReadonlyMap<ProjectId, string>;
  readonly task: Task;
}

/**
 * Whether the dispatcher is currently stepping over this task. Parking is set
 * when the retry threshold trips and expires by itself, so a timestamp in the
 * past is an ordinary task and only a future one is worth drawing.
 */
const isParked = (task: Task) =>
  task.parkedUntil !== null &&
  DateTime.toEpochMillis(task.parkedUntil) > Date.now();

/**
 * The one line of state a card carries.
 *
 * Sitting in *in progress* is not the same as being worked on: without a live
 * run the task is waiting for a slot or has stalled, and drawing both the same
 * way hides the only thing an operator scanning the column wants to know. A
 * spinner means a run is moving; anything else is a quiet marker.
 */
const runMarker = (task: Task, live: boolean) => {
  if (isParked(task)) {
    return (
      <Badge
        title={`Parked until ${task.parkedUntil === null ? "" : formatAbsolute(task.parkedUntil)}`}
        variant="destructive"
      >
        parked
      </Badge>
    );
  }
  if (task.status !== "in_progress") {
    return null;
  }
  if (live) {
    return (
      <span className="inline-flex items-center gap-1 text-muted-foreground">
        <Spinner className="size-3" />
        running
      </span>
    );
  }
  return <Badge variant="outline">waiting</Badge>;
};

/** The card around it opens the task, so a link inside keeps its click to itself. */
const keepClick = (event: ReactMouseEvent) => event.stopPropagation();

/**
 * A card's face, with no drag machinery attached.
 *
 * Split from {@link TaskCard} because the overlay that follows the pointer
 * during a drag has to render the same card without registering a second
 * sortable under the same id. Nothing decorative: a title that opens the task,
 * the project it belongs to, what its run is doing, and the pull request if one
 * exists.
 */
export const TaskCardFace = ({
  live,
  onOpen,
  projectNames,
  task,
}: CardProps) => {
  const open = useCallback(() => onOpen(task.id), [onOpen, task.id]);
  const marker = runMarker(task, live);
  const projectName =
    task.projectId === null ? null : (projectNames.get(task.projectId) ?? null);
  const hasFooter =
    projectName !== null || marker !== null || task.prUrl !== null;

  return (
    // The whole card is the way in, not only the title: the title stays the
    // control a keyboard or screen reader finds, and the card around it takes
    // the click a pointer actually aims at. The drag sensor's activation
    // distance keeps a press from becoming a drag before either happens.
    <Card className="gap-2" onClick={open} size="sm">
      <CardHeader>
        <CardTitle className="text-xs">
          {/** No handler of its own: the click bubbles up to the card, so pointer and keyboard open the task exactly once. */}
          <button className="line-clamp-3 text-left" type="button">
            {task.title}
          </button>
        </CardTitle>
      </CardHeader>
      {hasFooter ? (
        <CardContent className="flex flex-wrap items-center gap-1.5 text-muted-foreground">
          {projectName === null ? null : (
            <Badge variant="outline">{projectName}</Badge>
          )}
          {marker}
          {task.prUrl === null ? null : (
            <a
              className="inline-flex items-center gap-1 hover:text-foreground"
              href={task.prUrl}
              onClick={keepClick}
              rel="noreferrer"
              target="_blank"
            >
              <HugeiconsIcon
                className="size-3"
                icon={GitPullRequestIcon}
                strokeWidth={2}
              />
              PR
            </a>
          )}
        </CardContent>
      ) : null}
    </Card>
  );
};

/**
 * A card the pointer can pick up.
 *
 * The sortable id is the task id, which is what lets a drop name the card it
 * landed on without a lookup table beside the board. While a card is being
 * dragged its own copy fades and the overlay carries the visible one, so the
 * gap it leaves shows where it would land.
 */
export const TaskCard = ({ live, onOpen, projectNames, task }: CardProps) => {
  const { isDragging, listeners, setNodeRef, transform, transition } =
    useSortable({ id: task.id });

  return (
    // The sortable's `attributes` are deliberately not spread here. They exist
    // to drive a keyboard drag, and the board registers a mouse sensor only —
    // so all they would contribute is a `role="button"` and a tab stop wrapped
    // around the title button and the pull request link, which is a control
    // inside a control and reads to a screen reader as one unusable thing. The
    // title stays the card's accessible action.
    <div
      className={cn(isDragging && "opacity-30")}
      ref={setNodeRef}
      style={{ transform: CSS.Translate.toString(transform), transition }}
      {...listeners}
    >
      <TaskCardFace
        live={live}
        onOpen={onOpen}
        projectNames={projectNames}
        task={task}
      />
    </div>
  );
};
