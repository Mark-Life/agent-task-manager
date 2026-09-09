import {
  type CollisionDetection,
  DndContext,
  type DragEndEvent,
  type DragOverEvent,
  DragOverlay,
  type DragStartEvent,
  MouseSensor,
  pointerWithin,
  rectIntersection,
  TouchSensor,
  useSensor,
  useSensors,
} from "@dnd-kit/core";
import { Alert02Icon } from "@hugeicons/core-free-icons";
import { useQuery } from "@tanstack/react-query";
import type { BoardColumn } from "@workspace/api";
import {
  type ProjectId,
  TASK_STATUSES,
  type TaskId,
  type TaskStatus,
} from "@workspace/domain";
import { SidebarTrigger } from "@workspace/ui/components/sidebar";
import { cn } from "@workspace/ui/lib/utils";
import { type ReactNode, useCallback, useMemo, useState } from "react";
import { projectsQuery } from "@/api/projects";
import {
  boardQuery,
  useBoardStream,
  usePlaceTask,
  useTransitionTask,
} from "@/api/tasks";
import { EmptyState } from "@/components/empty-state";
import { TaskCardFace } from "@/features/board/card";
import { Column, ColumnSkeleton } from "@/features/board/column";
import { BoardFilters } from "@/features/board/filters";
import { NewTask } from "@/features/board/new-task";
import { allowedTargets, destinationOf, planDrop } from "@/features/board/rank";
import { DraftTask } from "@/features/task/draft";

/**
 * How far the pointer travels before a press becomes a drag. Small enough that
 * dragging feels immediate, large enough that a click on a card's title still
 * opens the task rather than nudging it half a pixel down its column.
 */
const DRAG_DISTANCE = 4;

/**
 * How long a finger rests on a card before the press becomes a drag.
 *
 * A finger has no hover and no second button, so the same touch has to serve
 * both of the card's gestures and only time can tell them apart: let go before
 * this and the task opens, hold past it and the card comes up. Long enough that
 * a tap is never mistaken for a hold, short enough that a hold does not feel
 * like the board has stopped responding.
 */
const TOUCH_HOLD_MS = 250;

/**
 * How far the finger may wander during that wait before the press is read as a
 * scroll instead. Without it a column could not be scrolled by a finger that
 * happens to start on a card, which is most of the column.
 */
const TOUCH_TOLERANCE = 6;

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

/** What the board needs from whoever mounted it: the filters, and where a card leads. */
interface BoardProps {
  readonly onOpenTask: (taskId: TaskId) => void;
  readonly onProjectChange: (projectId: ProjectId | null) => void;
  readonly onQueryChange: (query: string) => void;
  readonly projectId: ProjectId | null;
  readonly query: string;
}

/**
 * What a search keeps on screen: cards whose title or brief carries the text,
 * case and column blind. An empty search keeps everything, and keeps it by
 * reference, so the rendering below re-reads nothing for a filter nobody set.
 */
const filterColumns = (
  columns: readonly BoardColumn[],
  query: string
): readonly BoardColumn[] => {
  const needle = query.trim().toLowerCase();
  if (needle === "") {
    return columns;
  }
  return columns.map((column) => ({
    ...column,
    tasks: column.tasks.filter(
      (task) =>
        task.title.toLowerCase().includes(needle) ||
        task.brief.toLowerCase().includes(needle)
    ),
  }));
};

/**
 * Which cards have a run working on them right now.
 *
 * Read off the board itself. It used to be one request per card in progress on
 * a ten-second timer, purely to learn this one field, which made what a
 * dashboard costs a function of how many workers the operator was willing to
 * run; the board's own read carries it now, so the answer arrives with the
 * column the card is in and cannot disagree with it.
 */
const liveIdsOf = (columns: readonly BoardColumn[]) =>
  new Set(
    columns.flatMap((column) =>
      column.tasks.flatMap((task) => (task.liveRunId === null ? [] : [task.id]))
    )
  );

/**
 * The five columns, side by side, scrolling sideways rather than shrinking to
 * nothing.
 *
 * Sideways is the only direction this box scrolls: each column scrolls its own
 * cards, so the row of headings above them stays where it is and the operator
 * always knows which column they are reading. On a phone the sideways scroll
 * snaps, because five columns will not fit whatever is done to them and a
 * half-column resting under the thumb is the state worth making unreachable.
 */
const Columns = ({
  children,
  dragging = false,
}: {
  readonly children: ReactNode;
  /**
   * Snapping is off while a card is in the air. Carrying one to a column that
   * is off-screen means this strip scrolls under it, and a mandatory snap
   * fights every one of those scrolls back to the column it came from.
   */
  readonly dragging?: boolean;
}) => (
  <div
    className={cn(
      "flex min-h-0 flex-1 gap-3 overflow-x-auto overflow-y-hidden pb-2",
      dragging ? "snap-none" : "snap-x snap-mandatory sm:snap-none"
    )}
  >
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
  onQueryChange,
  projectId,
  query,
}: BoardProps) => {
  const [draggingId, setDraggingId] = useState<string | null>(null);
  const [overStatus, setOverStatus] = useState<TaskStatus | null>(null);
  /** The column a draft would file into, or null while no draft is open. */
  const [drafting, setDrafting] = useState<TaskStatus | null>(null);
  // One read when the screen opens, and after that the gateway says when
  // something moved — see `useBoardStream`. The stream writes into this query's
  // own cache, so everything below reads one board however it arrived.
  const board = useQuery(boardQuery(projectId));
  useBoardStream({ paused: draggingId !== null, projectId });
  const projects = useQuery(projectsQuery());
  const { mutate: transitionTask } = useTransitionTask();
  const { mutate: placeTask } = usePlaceTask();

  const columns = board.data ?? NO_COLUMNS;
  // The search narrows what is drawn; dragging, the live-run reads and the
  // drop maths keep the full board, so a card a filter hides keeps its place
  // rather than vanishing from the gesture it is part of.
  const visibleColumns = useMemo(
    () => filterColumns(columns, query),
    [columns, query]
  );
  const liveTaskIds = useMemo(() => liveIdsOf(columns), [columns]);
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

  // A pointer says what it means by moving; a finger says it by waiting.
  const sensors = useSensors(
    useSensor(MouseSensor, {
      activationConstraint: { distance: DRAG_DISTANCE },
    }),
    useSensor(TouchSensor, {
      activationConstraint: {
        delay: TOUCH_HOLD_MS,
        tolerance: TOUCH_TOLERANCE,
      },
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

  // Where a new task lands is decided by the button that was pressed: the
  // toolbar files into ideas, a column's own button files into that column.
  const openDraft = useCallback(() => setDrafting("ideas"), []);
  const openDraftIn = useCallback(
    (status: TaskStatus) => setDrafting(status),
    []
  );
  const closeDraft = useCallback((open: boolean) => {
    if (!open) {
      setDrafting(null);
    }
  }, []);

  // A filed draft stops being a draft the moment it exists: the panel closes
  // and the board's own "open a task" gesture takes over with the real id.
  const filedDraft = useCallback(
    (taskId: TaskId) => {
      setDrafting(null);
      onOpenTask(taskId);
    },
    [onOpenTask]
  );

  return (
    <div className="flex h-full min-h-0 min-w-0 flex-col gap-3 p-3 sm:gap-4 sm:p-4">
      <div className="flex min-w-0 items-center gap-2 sm:gap-3">
        {/* The way back to the sidebar, which on a phone is a sheet over this. */}
        <SidebarTrigger
          className="shrink-0 md:hidden"
          size="icon"
          variant="outline"
        />
        <BoardFilters
          onProjectChange={onProjectChange}
          onQueryChange={onQueryChange}
          projectId={projectId}
          query={query}
        />
        <NewTask onOpen={openDraft} />
      </div>

      <DraftTask
        onFiled={filedDraft}
        onOpenChange={closeDraft}
        open={drafting !== null}
        status={drafting ?? "ideas"}
      />

      {board.isPending ? (
        <Columns>
          {TASK_STATUSES.map((status) => (
            <ColumnSkeleton key={status} status={status} />
          ))}
        </Columns>
      ) : null}

      {board.error === null ? null : (
        <EmptyState
          description="Nothing was changed. It will be retried on the next refresh."
          icon={Alert02Icon}
          title="The board could not be read"
        />
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
          <Columns dragging={draggingId !== null}>
            {TASK_STATUSES.map((status) => (
              <Column
                droppable={targets === null || targets.has(status)}
                highlighted={overStatus === status}
                key={status}
                liveTaskIds={liveTaskIds}
                onNewTask={openDraftIn}
                onOpenTask={onOpenTask}
                projectNames={projectNames}
                status={status}
                tasks={
                  visibleColumns.find((column) => column.status === status)
                    ?.tasks ?? []
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
