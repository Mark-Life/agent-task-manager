import type { QueryClient } from "@tanstack/react-query";
import {
  createRootRouteWithContext,
  Link,
  Outlet,
} from "@tanstack/react-router";
import { Button } from "@workspace/ui/components/button";
import {
  Empty,
  EmptyContent,
  EmptyDescription,
  EmptyHeader,
  EmptyTitle,
} from "@workspace/ui/components/empty";
import { RootError } from "@/components/error-boundary";

/**
 * What every route can reach without importing it.
 *
 * The cache is the one thing worth carrying here: a loader and a component that
 * ask for the same key have to get the same in-flight request, and passing the
 * client through context is what lets a route prefetch without reaching for a
 * module-level singleton it would then be coupled to.
 */
export interface RouterContext {
  readonly queryClient: QueryClient;
}

/**
 * An address that resolves to nothing.
 *
 * Written as a way back rather than an apology: the operator arrived here from
 * a stale link — a task that was deleted, a path from an older build — and the
 * only useful thing on the page is the board.
 */
const NotFound = () => (
  <div className="flex min-h-svh items-center justify-center bg-background p-6">
    <Empty className="max-w-md">
      <EmptyHeader>
        <EmptyTitle>There is nothing at this address</EmptyTitle>
        <EmptyDescription>
          The link may be from an older build, or it pointed at something that
          has since been deleted.
        </EmptyDescription>
      </EmptyHeader>
      <EmptyContent>
        <Button
          nativeButton={false}
          render={<Link to="/" />}
          size="sm"
          variant="outline"
        >
          Go to the board
        </Button>
      </EmptyContent>
    </Empty>
  </div>
);

/**
 * The route everything hangs off.
 *
 * It renders nothing of its own — the frame belongs to the authenticated layout
 * beneath it, because the sign-in screen must not be wrapped in a sidebar that
 * links to pages a signed-out visitor cannot open. What it does own is the last
 * error boundary in the app and the answer for an address that matches nothing.
 */
export const rootRoute = createRootRouteWithContext<RouterContext>()({
  component: Outlet,
  errorComponent: RootError,
  notFoundComponent: NotFound,
});
