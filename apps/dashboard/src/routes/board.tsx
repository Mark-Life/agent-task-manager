import { createRoute, lazyRouteComponent } from "@tanstack/react-router";
import type { ProjectId, TaskId } from "@workspace/domain";
import { RouteError } from "@/components/error-boundary";
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
 * The board owns the root address: it is the screen the operator lives on.
 *
 * What is at the address is fetched when somebody goes there, while the address
 * itself — its path and the shape of its search — stays here in the eagerly
 * loaded tree. The router needs the second to route at all, and would need the
 * whole board, its cards and the drag machinery underneath them to have it if
 * the two lived in one module.
 */
export const boardRoute = createRoute({
  component: lazyRouteComponent(
    () => import("@/routes/board.screen"),
    "BoardScreen"
  ),
  errorComponent: RouteError,
  getParentRoute: () => layoutRoute,
  path: "/",
  validateSearch,
});
