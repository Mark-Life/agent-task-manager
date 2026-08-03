import { useDroppable } from "@dnd-kit/core";
import {
  SortableContext,
  verticalListSortingStrategy,
} from "@dnd-kit/sortable";
import type { Task } from "@workspace/api";
import type { ProjectId, TaskId, TaskStatus } from "@workspace/domain";
import {
  Empty,
  EmptyDescription,
  EmptyHeader,
} from "@workspace/ui/components/empty";
import { Skeleton } from "@workspace/ui/components/skeleton";
import { cn } from "@workspace/ui/lib/utils";
import { type ReactNode, useMemo } from "react";
import { TaskCard } from "@/features/board/card";

/** How a column is named on screen. The status itself is never shown to anyone. */
export const STATUS_LABELS: Record<TaskStatus, string> = {
  backlog: "Backlog",
  done: "Done",
  ideas: "Ideas",
  in_progress: "In progress",
  review: "Review",
};

/** How many placeholder cards a loading column draws before anything is known. */
const SKELETON_CARDS = 3;

interface ColumnProps {
  /** Whether the card currently being dragged may land here at all. */
  readonly droppable: boolean;
  readonly liveTaskIds: ReadonlySet<TaskId>;
  readonly onOpenTask: (taskId: TaskId) => void;
  readonly projectNames: ReadonlyMap<ProjectId, string>;
  readonly status: TaskStatus;
  readonly tasks: readonly Task[];
}

/** The frame every column shares, so a loading one lines up with a loaded one. */
const Frame = ({
  children,
  count,
  status,
}: {
  readonly children: ReactNode;
  readonly count: ReactNode;
  readonly status: TaskStatus;
}) => (
  <section className="flex min-h-0 min-w-56 flex-1 flex-col gap-2">
    <header className="flex items-baseline justify-between px-1">
      <span className="font-medium text-xs">{STATUS_LABELS[status]}</span>
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
 * The column registers as a droppable under its own status so that the empty
 * space below the last card still accepts a drop — without it a column nothing
 * is in could never be filled by a gesture. Columns the dragged card may not
 * legally reach are dimmed rather than hidden: the operator can see where the
 * card cannot go, and the drop is refused whether or not they aim there.
 */
export const Column = ({
  droppable,
  liveTaskIds,
  onOpenTask,
  projectNames,
  status,
  tasks,
}: ColumnProps) => {
  const { isOver, setNodeRef } = useDroppable({
    disabled: !droppable,
    id: status,
  });
  const ids = useMemo(() => tasks.map((task) => task.id), [tasks]);

  return (
    <Frame count={tasks.length} status={status}>
      <div
        className={cn(
          "flex min-h-0 flex-1 flex-col gap-2 overflow-y-auto rounded-lg p-1 transition-colors",
          isOver && "bg-muted/50",
          !droppable && "opacity-40"
        )}
        ref={setNodeRef}
      >
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
        {tasks.length === 0 ? (
          <Empty className="min-h-24 border border-border">
            <EmptyHeader>
              <EmptyDescription>Nothing here</EmptyDescription>
            </EmptyHeader>
          </Empty>
        ) : null}
      </div>
    </Frame>
  );
};

/**
 * A column before its cards are known. Card-shaped rather than a spinner, so
 * the board's five columns are already in place when the data arrives and
 * nothing jumps sideways under the pointer.
 */
export const ColumnSkeleton = ({ status }: { readonly status: TaskStatus }) => (
  <Frame count={null} status={status}>
    <div className="flex flex-col gap-2 p-1">
      {Array.from({ length: SKELETON_CARDS }, (_unused, index) => (
        <Skeleton className="h-16 rounded-lg" key={`${status}-${index}`} />
      ))}
    </div>
  </Frame>
);
