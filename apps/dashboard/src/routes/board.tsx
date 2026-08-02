import { createRoute } from "@tanstack/react-router";
import type { ProjectId, TaskId } from "@workspace/domain";
import { useCallback } from "react";
import { RouteError } from "@/components/error-boundary";
import { Board } from "@/features/board/board";
import { layoutRoute } from "@/routes/layout";
import { parseProjectId } from "@/routes/search";

/**
 * The project filter lives in the URL rather than in the board's own state, so
 * a filtered board is a link somebody can send. An id that names nothing
 * readable falls back to every project, which is the screen's opening state
 * anyway.
 */
export interface BoardSearch {
  readonly projectId?: ProjectId;
}

const validateSearch = (search: Record<string, unknown>): BoardSearch => ({
  projectId: parseProjectId(search.projectId),
});

/**
 * The board, wired to the two things it refuses to know about itself: where a
 * card leads, and where the filter is kept.
 *
 * Opening a task is a navigation rather than a panel, because a task page is
 * something the Telegram bot links straight into and the two have to arrive at
 * the same screen.
 */
const BoardScreen = () => {
  const { projectId } = boardRoute.useSearch();
  const navigate = boardRoute.useNavigate();

  const openTask = useCallback(
    (taskId: TaskId) => {
      navigate({ params: { taskId }, to: "/tasks/$taskId" });
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

  return (
    <Board
      onOpenTask={openTask}
      onProjectChange={changeProject}
      projectId={projectId ?? null}
    />
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
