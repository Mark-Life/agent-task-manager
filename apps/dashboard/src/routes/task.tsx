import { createRoute, lazyRouteComponent } from "@tanstack/react-router";
import type { RunId } from "@workspace/domain";
import { RouteError } from "@/components/error-boundary";
import { layoutRoute } from "@/routes/layout";
import { parseRunId, parseTaskTab, type TaskTab } from "@/routes/search";

/**
 * Both parameters name something the reader chose to look at, which is why they
 * are in the URL: a link to one attempt of one task, on the panel it is about,
 * is the thing an operator sends to themselves at three in the morning.
 */
export interface TaskSearch {
  readonly runId?: RunId;
  readonly tab?: TaskTab;
}

const validateSearch = (search: Record<string, unknown>): TaskSearch => ({
  runId: parseRunId(search.runId),
  tab: parseTaskTab(search.tab),
});

/**
 * The one address that is a contract with something outside this app: the
 * Telegram bot builds task links as `/tasks/<taskId>`, so this path is fixed
 * and cannot be reshaped without breaking every notification already sent.
 *
 * The screen behind it is fetched on arrival: a task's six panels — its
 * timeline, artifacts, proposals and the rest — are the largest thing this app
 * draws, and the board is where most sessions start.
 */
export const taskRoute = createRoute({
  component: lazyRouteComponent(
    () => import("@/routes/task.screen"),
    "TaskScreen"
  ),
  errorComponent: RouteError,
  getParentRoute: () => layoutRoute,
  path: "/tasks/$taskId",
  validateSearch,
});
