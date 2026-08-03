import {
  closestCorners,
  DndContext,
  type DragEndEvent,
  DragOverlay,
  type DragStartEvent,
  PointerSensor,
  useSensor,
  useSensors,
} from "@dnd-kit/core";
import { useQueries, useQuery } from "@tanstack/react-query";
import type { BoardColumn, Task, TaskDetail } from "@workspace/api";
import { type ProjectId, TASK_STATUSES, type TaskId } from "@workspace/domain";
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
import { allowedTargets, planDrop } from "@/features/board/rank";

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
 * A drag is answered locally first: the status machine decides whether the drop
 * is legal, the mutation writes the new position into the cache, and only then
 * does the request leave. Dropping a card into *in progress* is not confirmed
 * by a dialog — that move is itself the instruction to spend a worker slot, and
 * a confirmation would only ask the operator to repeat the gesture they just
 * made.
 */
export const Board = ({
  onOpenTask,
  onProjectChange,
  projectId,
}: BoardProps) => {
  const [draggingId, setDraggingId] = useState<string | null>(null);
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
  }, []);

  const onDragCancel = useCallback(() => {
    setDraggingId(null);
  }, []);

  const onDragEnd = useCallback(
    (event: DragEndEvent) => {
      setDraggingId(null);
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
          collisionDetection={closestCorners}
          onDragCancel={onDragCancel}
          onDragEnd={onDragEnd}
          onDragStart={onDragStart}
          sensors={sensors}
        >
          <Columns>
            {TASK_STATUSES.map((status) => (
              <Column
                droppable={targets === null || targets.has(status)}
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
