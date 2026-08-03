import {
  type CollisionDetection,
  DndContext,
  type DragEndEvent,
  type DragOverEvent,
  DragOverlay,
  type DragStartEvent,
  PointerSensor,
  pointerWithin,
  rectIntersection,
  useSensor,
  useSensors,
} from "@dnd-kit/core";
import { useQueries, useQuery } from "@tanstack/react-query";
import type { BoardColumn, Task, TaskDetail } from "@workspace/api";
import {
  type ProjectId,
  TASK_STATUSES,
  type TaskId,
  type TaskStatus,
} from "@workspace/domain";
import {
  Empty,
  EmptyDescription,
  EmptyHeader,
  EmptyTitle,
} from "@workspace/ui/components/empty";
import { type ReactNode, useCallback, useMemo, useState } from "react";
import { projectsQuery } from "@/api/projects";
import {
  boardQuery,
  taskQuery,
  usePlaceTask,
  useTransitionTask,
} from "@/api/tasks";
import { TaskCardFace } from "@/features/board/card";
import { Column, ColumnSkeleton } from "@/features/board/column";
import { BoardFilters } from "@/features/board/filters";
import { NewTask } from "@/features/board/new-task";
import { allowedTargets, destinationOf, planDrop } from "@/features/board/rank";

/**
 * How far the pointer travels before a press becomes a drag. Small enough that
 * dragging feels immediate, large enough that a click on a card's title still
 * opens the task rather than nudging it half a pixel down its column.
 */
const DRAG_DISTANCE = 4;

/** How often the board re-reads itself while nobody is dragging on it. */
const BOARD_POLL_MS = 10_000;

/** How often a task in progress is asked whether a run is still on it. */
const LIVE_POLL_MS = 5000;

/** One reference for "no columns yet", so nothing downstream re-derives on every render. */
const NO_COLUMNS: readonly BoardColumn[] = [];

/**
 * What the pointer is over, and only then what it is near.
 *
 * The pointer decides, because a column is a tall target and a card is a small
 * one: any strategy that measures rectangles against each other lets a card in a
 * neighbouring column win over the column the pointer is actually inside, which
 * is how the top half of a column came to refuse drops — the columns beside it
 * are full of cards up there, and empty further down. Asking "which droppables
 * contain the pointer" removes the comparison entirely; among those, dnd-kit
 * prefers the smallest, so hovering a card still resolves to that card and
 * hovering a column's empty space resolves to the column.
 *
 * The fallback covers the pointer being between two columns or outside the
 * board, where nothing contains it and the greatest overlap with the dragged
 * card is the best available guess.
 */
const overOrNear: CollisionDetection = (args) => {
  const under = pointerWithin(args);
  return under.length > 0 ? under : rectIntersection(args);
};

/** What the board needs from whoever mounted it: the filter, and where a card leads. */
interface BoardProps {
  readonly onOpenTask: (taskId: TaskId) => void;
  readonly onProjectChange: (projectId: ProjectId | null) => void;
  readonly projectId: ProjectId | null;
}

const liveIdsOf = (
  results: readonly { readonly data?: TaskDetail | undefined }[]
) =>
  new Set(
    results.flatMap((result) =>
      result.data === undefined || result.data.liveRunId === null
        ? []
        : [result.data.task.id]
    )
  );

/**
 * Which of these tasks has a run working on it right now.
 *
 * The board's own read carries cards and not runs, so the answer costs one
 * small read per card in progress — the only column where it is ever anything
 * but "none", and a column bounded by how many slots the operator is willing to
 * spend. The reads land on the task's own cache key, so opening one of these
 * cards finds its detail already there.
 */
const useLiveRuns = (tasks: readonly Task[]) => {
  const queries = useMemo(
    () =>
      tasks.map((task) => ({
        ...taskQuery(task.id),
        refetchInterval: LIVE_POLL_MS,
      })),
    [tasks]
  );
  return useQueries({ combine: liveIdsOf, queries });
};

/** The five columns, side by side, scrolling sideways rather than shrinking to nothing. */
const Columns = ({ children }: { readonly children: ReactNode }) => (
  <div className="flex min-h-0 flex-1 gap-3 overflow-x-auto pb-2">
    {children}
  </div>
);

/**
 * The board, and the gesture that moves work through it.
 *
 * A drag is answered locally first: the mutation writes the new position into
 * the cache and only then does the request leave. Every column reaches every
 * other one in either direction, so what the status machine still refuses a
 * person is nothing — it is asked all the same, in one place, rather than the
 * board deciding for itself that it agrees.
 *
 * Dropping a card into *in progress* is not confirmed by a dialog: that move is
 * itself the instruction to spend a worker slot, and a confirmation would only
 * ask the operator to repeat the gesture they just made. Dragging one *out* of
 * it while a run is live asks that run to stop, which is the gateway's doing and
 * the same row the Stop button writes.
 */
export const Board = ({
  onOpenTask,
  onProjectChange,
  projectId,
}: BoardProps) => {
  const [draggingId, setDraggingId] = useState<string | null>(null);
  const [overStatus, setOverStatus] = useState<TaskStatus | null>(null);
  const board = useQuery({
    ...boardQuery(projectId),
    refetchInterval: draggingId === null ? BOARD_POLL_MS : false,
  });
  const projects = useQuery(projectsQuery());
  const { mutate: transitionTask } = useTransitionTask();
  const { mutate: placeTask } = usePlaceTask();

  const columns = board.data ?? NO_COLUMNS;
  const inProgress = useMemo(
    () =>
      columns.find((column) => column.status === "in_progress")?.tasks ?? [],
    [columns]
  );
  const liveTaskIds = useLiveRuns(inProgress);
  const projectNames = useMemo(
    () =>
      new Map(
        (projects.data ?? []).map((project) => [project.id, project.name])
      ),
    [projects.data]
  );

  const dragged = useMemo(
    () =>
      draggingId === null
        ? undefined
        : columns
            .flatMap((column) => column.tasks)
            .find((task) => task.id === draggingId),
    [columns, draggingId]
  );
  const targets = dragged === undefined ? null : allowedTargets(dragged.status);

  const sensors = useSensors(
    useSensor(PointerSensor, {
      activationConstraint: { distance: DRAG_DISTANCE },
    })
  );

  const onDragStart = useCallback((event: DragStartEvent) => {
    setDraggingId(String(event.active.id));
    setOverStatus(null);
  }, []);

  const onDragCancel = useCallback(() => {
    setDraggingId(null);
    setOverStatus(null);
  }, []);

  // Which column would take the card, so it can say so over its whole height
  // rather than only where the pointer happens to be.
  const onDragOver = useCallback(
    (event: DragOverEvent) => {
      setOverStatus(
        event.over === null
          ? null
          : destinationOf(columns, String(event.over.id))
      );
    },
    [columns]
  );

  const onDragEnd = useCallback(
    (event: DragEndEvent) => {
      setDraggingId(null);
      setOverStatus(null);
      if (event.over === null) {
        return;
      }
      const plan = planDrop({
        activeId: String(event.active.id),
        columns,
        overId: String(event.over.id),
      });
      if (plan === null) {
        return;
      }
      if (plan.kind === "place") {
        placeTask(plan);
        return;
      }
      transitionTask(plan);
    },
    [columns, placeTask, transitionTask]
  );

  return (
    <div className="flex h-full min-h-0 min-w-0 flex-col gap-4 p-4">
      <div className="flex items-center justify-between gap-3">
        <BoardFilters onProjectChange={onProjectChange} projectId={projectId} />
        <NewTask onCreated={onOpenTask} />
      </div>

      {board.isPending ? (
        <Columns>
          {TASK_STATUSES.map((status) => (
            <ColumnSkeleton key={status} status={status} />
          ))}
        </Columns>
      ) : null}

      {board.error === null ? null : (
        <Empty className="border border-border">
          <EmptyHeader>
            <EmptyTitle>The board could not be read</EmptyTitle>
            <EmptyDescription>
              Nothing was changed. It will be retried on the next refresh.
            </EmptyDescription>
          </EmptyHeader>
        </Empty>
      )}

      {board.data === undefined ? null : (
        <DndContext
          collisionDetection={overOrNear}
          onDragCancel={onDragCancel}
          onDragEnd={onDragEnd}
          onDragOver={onDragOver}
          onDragStart={onDragStart}
          sensors={sensors}
        >
          <Columns>
            {TASK_STATUSES.map((status) => (
              <Column
                droppable={targets === null || targets.has(status)}
                highlighted={overStatus === status}
                key={status}
                liveTaskIds={liveTaskIds}
                onOpenTask={onOpenTask}
                projectNames={projectNames}
                status={status}
                tasks={
                  columns.find((column) => column.status === status)?.tasks ??
                  []
                }
              />
            ))}
          </Columns>
          <DragOverlay>
            {dragged === undefined ? null : (
              <TaskCardFace
                live={liveTaskIds.has(dragged.id)}
                onOpen={onOpenTask}
                projectNames={projectNames}
                task={dragged}
              />
            )}
          </DragOverlay>
        </DndContext>
      )}
    </div>
  );
};
