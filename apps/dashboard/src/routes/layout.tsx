import { createRoute, useNavigate } from "@tanstack/react-router";
import type { ThreadId } from "@workspace/domain";
import { useCallback } from "react";
import { RequireSession } from "@/auth/guard";
import { RouteError } from "@/components/error-boundary";
import { Shell } from "@/components/shell";
import { ChatOverlay } from "@/features/chat/overlay";
import { ThreadList } from "@/features/chat/thread-list";
import { rootRoute } from "@/routes/root";
import { parseThreadId } from "@/routes/search";

/**
 * Which conversation is open, as a fact about the URL.
 *
 * A conversation is read over the top of whatever screen the operator was on,
 * so it cannot be a path of its own without throwing that screen away. Holding
 * it here instead means the overlay works from the board, a task or the project
 * list alike, and a link carrying `?thread=` opens the same conversation over
 * the same page for whoever receives it.
 */
export interface LayoutSearch {
  readonly thread?: ThreadId;
}

/**
 * The key is optional rather than nullable so that every link in the app can
 * leave it out: a required parameter, even one allowed to be undefined, makes
 * `search` compulsory at every call site that navigates anywhere.
 */
const parseLayoutSearch = (search: Record<string, unknown>): LayoutSearch => ({
  thread: parseThreadId(search.thread),
});

/**
 * Everything a signed-in operator sees.
 *
 * The guard, the frame and the conversation overlay are one route because they
 * share a lifetime: the sidebar and its conversation list stay mounted while
 * the board, a task page and the project list replace one another beneath, so
 * scroll position and in-flight reads survive navigation.
 */
const AuthenticatedLayout = () => {
  const { thread } = layoutRoute.useSearch();

  // Deliberately the free hook rather than this route's own: a route with no
  // path answers for the root address, so binding `from` to it would resolve
  // `to: "."` against `/` and drop the reader onto the board every time a
  // conversation is opened or closed. Unbound, `.` means the page on screen.
  const navigate = useNavigate();

  const openThread = useCallback(
    (threadId: ThreadId) => {
      navigate({
        search: (previous) => ({ ...previous, thread: threadId }),
        to: ".",
      });
    },
    [navigate]
  );

  // Closing is the same navigation with the parameter dropped, so the back
  // button reopens the conversation rather than leaving a panel that the URL
  // says is open and the screen says is not.
  const closeThread = useCallback(
    (open: boolean) => {
      if (!open) {
        navigate({
          search: (previous) => ({ ...previous, thread: undefined }),
          to: ".",
        });
      }
    },
    [navigate]
  );

  const openOn = thread ?? null;

  return (
    <RequireSession>
      <Shell
        conversations={
          <ThreadList activeThreadId={openOn} onOpenThread={openThread} />
        }
      >
        <ChatOverlay onOpenChange={closeThread} threadId={openOn} />
      </Shell>
    </RequireSession>
  );
};

/**
 * A layout with no path of its own, so the board can keep the root address.
 *
 * Its children inherit the `thread` parameter, which is what lets the overlay
 * be opened from any of them without each screen restating it.
 */
export const layoutRoute = createRoute({
  component: AuthenticatedLayout,
  errorComponent: RouteError,
  getParentRoute: () => rootRoute,
  id: "authenticated",
  validateSearch: parseLayoutSearch,
});
