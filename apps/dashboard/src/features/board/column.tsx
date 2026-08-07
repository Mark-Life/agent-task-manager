import { useDroppable } from "@dnd-kit/core";
import {
  SortableContext,
  verticalListSortingStrategy,
} from "@dnd-kit/sortable";
import { PlusSignIcon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import type { Task } from "@workspace/api";
import type { ProjectId, TaskId, TaskStatus } from "@workspace/domain";
import { Skeleton } from "@workspace/ui/components/skeleton";
import { cn } from "@workspace/ui/lib/utils";
import { type ReactNode, type Ref, useCallback, useMemo } from "react";
import { TaskCard } from "@/features/board/card";
import { STATUS_LABELS, StatusDot } from "@/features/task/status-select";

/** How many placeholder cards a loading column draws before anything is known. */
const SKELETON_CARDS = 3;

interface ColumnProps {
  /** Whether the card currently being dragged may land here at all. */
  readonly droppable: boolean;
  /** Whether a card is being dragged and this is where it would land. */
  readonly highlighted: boolean;
  readonly liveTaskIds: ReadonlySet<TaskId>;
  /** Opens a draft that files into this column. */
  readonly onNewTask: (status: TaskStatus) => void;
  readonly onOpenTask: (taskId: TaskId) => void;
  readonly projectNames: ReadonlyMap<ProjectId, string>;
  readonly status: TaskStatus;
  readonly tasks: readonly Task[];
}

interface FrameProps {
  readonly children: ReactNode;
  readonly className?: string;
  readonly count: ReactNode;
  /** The column's own element, which is the drop target on a loaded board. */
  readonly ref?: Ref<HTMLElement>;
  readonly status: TaskStatus;
}

/**
 * The frame every column shares, so a loading one lines up with a loaded one.
 *
 * The heading is inside it rather than above it, because the frame is what a
 * drop is measured against: a header sitting outside the drop target is a strip
 * along the top of every column where a release does nothing.
 */
const Frame = ({ children, className, count, ref, status }: FrameProps) => (
  <section
    className={cn(
      "flex min-h-0 min-w-56 flex-1 flex-col gap-2 rounded-lg p-1 transition-colors",
      className
    )}
    ref={ref}
  >
    <header className="flex items-center justify-between px-1">
      <span className="flex items-center gap-2 font-medium text-xs">
        <StatusDot status={status} />
        {STATUS_LABELS[status]}
      </span>
      <span className="text-muted-foreground text-xs tabular-nums">
        {count}
      </span>
    </header>
    {children}
  </section>
);

/**
 * One column of the board, and one drop target.
 *
 * **The whole column is the target, header and empty space included.** It used
 * to be the card list, which is an element that collapses to the height of what
 * is in it — so an empty column accepted a drop only where its placeholder
 * happened to sit, and a full one refused the strip under its heading. A person
 * dragging a card aims at a column, and the column is what they see.
 *
 * The highlight is passed in rather than read off this droppable's own `isOver`,
 * for the same reason: hovering one of its cards is still hovering the column,
 * and a highlight that blinked out whenever the pointer crossed a card would
 * report a refusal that is not happening. Columns the dragged card may not
 * legally reach are dimmed rather than hidden.
 */
export const Column = ({
  droppable,
  highlighted,
  liveTaskIds,
  onNewTask,
  onOpenTask,
  projectNames,
  status,
  tasks,
}: ColumnProps) => {
  const { setNodeRef } = useDroppable({ disabled: !droppable, id: status });
  const ids = useMemo(() => tasks.map((task) => task.id), [tasks]);
  const newTask = useCallback(() => onNewTask(status), [onNewTask, status]);

  return (
    <Frame
      className={cn(
        highlighted && "bg-muted/50 ring-1 ring-ring/30",
        !droppable && "opacity-40"
      )}
      count={tasks.length}
      ref={setNodeRef}
      status={status}
    >
      {/* The 1px bleed is for the cards' ring: a ring is a shadow drawn outside the card's box, and a scrolling box clips whatever crosses its edge, so without it every card loses its ring on both sides. */}
      <div className="-m-px flex min-h-0 flex-1 flex-col gap-2 overflow-y-auto p-px">
        <SortableContext items={ids} strategy={verticalListSortingStrategy}>
          {tasks.map((task) => (
            <TaskCard
              key={task.id}
              live={liveTaskIds.has(task.id)}
              onOpen={onOpenTask}
              projectNames={projectNames}
              task={task}
            />
          ))}
        </SortableContext>
        <NewTaskCard onNewTask={newTask} />
      </div>
    </Frame>
  );
};

/**
 * The last card in the column, which is not a task but the way to add one.
 *
 * It rides at the end of the list rather than being pinned under it, so it sits
 * directly beneath the last card and lands at a different height in every
 * column — which is what makes it read as the next card rather than as a
 * toolbar. In an empty column it is the only thing there, so the column that
 * has nothing in it and the column that has ten offer the same gesture in the
 * same place relative to what they hold.
 *
 * Dashed and quiet: it is card-shaped without pretending to be a task, and the
 * dashes are the same language the drop target speaks.
 */
const NewTaskCard = ({ onNewTask }: { readonly onNewTask: () => void }) => (
  <button
    className="flex w-full shrink-0 items-center gap-1.5 rounded-lg border border-border border-dashed px-3 py-2.5 text-left text-muted-foreground text-xs transition-colors hover:border-ring/40 hover:bg-muted/50 hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/30"
    onClick={onNewTask}
    type="button"
  >
    <HugeiconsIcon className="size-3.5" icon={PlusSignIcon} strokeWidth={2} />
    New task
  </button>
);

/**
 * A column before its cards are known. Card-shaped rather than a spinner, so
 * the board's five columns are already in place when the data arrives and
 * nothing jumps sideways under the pointer.
 */
export const ColumnSkeleton = ({ status }: { readonly status: TaskStatus }) => (
  <Frame count={null} status={status}>
    <div className="flex flex-col gap-2">
      {Array.from({ length: SKELETON_CARDS }, (_unused, index) => (
        <Skeleton className="h-16 rounded-lg" key={`${status}-${index}`} />
      ))}
    </div>
  </Frame>
);
