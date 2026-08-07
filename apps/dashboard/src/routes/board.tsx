import { createRoute } from "@tanstack/react-router";
import type { ProjectId, TaskId } from "@workspace/domain";
import { useCallback } from "react";
import { RouteError } from "@/components/error-boundary";
import { Board } from "@/features/board/board";
import { TaskOverlay } from "@/features/task/overlay";
import { layoutRoute } from "@/routes/layout";
import { parseProjectId, parseSearchText, parseTaskId } from "@/routes/search";

/**
 * The project filter lives in the URL rather than in the board's own state, so
 * a filtered board is a link somebody can send. An id that names nothing
 * readable falls back to every project, which is the screen's opening state
 * anyway.
 *
 * The open task is here for the same reason the open conversation is in the
 * layout: it is read over the board rather than instead of it, so the panel is
 * a search parameter and `/?task=` is a link that opens it.
 */
export interface BoardSearch {
  readonly projectId?: ProjectId;
  /** The text the visible cards are filtered by. */
  readonly q?: string;
  readonly task?: TaskId;
}

const validateSearch = (search: Record<string, unknown>): BoardSearch => ({
  projectId: parseProjectId(search.projectId),
  q: parseSearchText(search.q),
  task: parseTaskId(search.task),
});

/**
 * The board, wired to the two things it refuses to know about itself: what
 * opening a card does, and where the filter is kept.
 *
 * Opening a task is an overlay rather than a navigation: most opens from the
 * board are a glance, and a page change would throw the board's scroll and
 * in-flight reads away for it. The task page at `/tasks/<taskId>` still
 * stands, because the Telegram bot links straight into it.
 */
const BoardScreen = () => {
  const { projectId, q, task } = boardRoute.useSearch();
  const navigate = boardRoute.useNavigate();

  const openTask = useCallback(
    (taskId: TaskId) => {
      navigate({
        search: (previous) => ({ ...previous, task: taskId }),
        to: ".",
      });
    },
    [navigate]
  );

  // Closing is the same navigation with the parameter dropped, so the back
  // button reopens the panel rather than leaving one the URL says is open.
  const closeTask = useCallback(
    (open: boolean) => {
      if (!open) {
        navigate({
          search: (previous) => ({ ...previous, task: undefined }),
          to: ".",
        });
      }
    },
    [navigate]
  );

  const changeProject = useCallback(
    (next: ProjectId | null) => {
      navigate({
        search: (previous) => ({ ...previous, projectId: next ?? undefined }),
        to: ".",
      });
    },
    [navigate]
  );

  // Typing replaces rather than pushes, so a search is one history entry
  // rather than one per keystroke.
  const changeQuery = useCallback(
    (next: string) => {
      navigate({
        replace: true,
        search: (previous) => ({ ...previous, q: next || undefined }),
        to: ".",
      });
    },
    [navigate]
  );

  return (
    <>
      <Board
        onOpenTask={openTask}
        onProjectChange={changeProject}
        onQueryChange={changeQuery}
        projectId={projectId ?? null}
        query={q ?? ""}
      />
      <TaskOverlay onOpenChange={closeTask} taskId={task ?? null} />
    </>
  );
};

/** The board owns the root address: it is the screen the operator lives on. */
export const boardRoute = createRoute({
  component: BoardScreen,
  errorComponent: RouteError,
  getParentRoute: () => layoutRoute,
  path: "/",
  validateSearch,
});
