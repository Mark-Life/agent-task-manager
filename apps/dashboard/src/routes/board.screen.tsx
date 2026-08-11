import type { ProjectId, TaskId } from "@workspace/domain";
import { useCallback } from "react";
import { Board } from "@/features/board/board";
import { TaskOverlay } from "@/features/task/overlay";
import { boardRoute } from "@/routes/board";

/**
 * The board, wired to the two things it refuses to know about itself: what
 * opening a card does, and where the filter is kept.
 *
 * Opening a task is an overlay rather than a navigation: most opens from the
 * board are a glance, and a page change would throw the board's scroll and
 * in-flight reads away for it. The task page at `/tasks/<taskId>` still
 * stands, because the Telegram bot links straight into it.
 *
 * Reaching back for the route this screen hangs off is a cycle on paper and
 * none in practice: the route module is what dynamically imports this one, so
 * it has finished evaluating before any of this runs. It is the pairing worth
 * having — `getRouteApi` would want the route's full id, `/authenticated/`,
 * which spells the pathless layout above it into a string that no longer type
 * errors if that layout is ever renamed.
 */
export const BoardScreen = () => {
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
