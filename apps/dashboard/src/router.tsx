import { createRouter } from "@tanstack/react-router";
import { Spinner } from "@workspace/ui/components/spinner";
import { queryClient } from "@/lib/query-client";
import { apiKeysRoute } from "@/routes/api-keys";
import { boardRoute } from "@/routes/board";
import { filesRoute } from "@/routes/files";
import { layoutRoute } from "@/routes/layout";
import { loginRoute } from "@/routes/login";
import { projectsRoute } from "@/routes/projects";
import { rootRoute } from "@/routes/root";
import { taskRoute } from "@/routes/task";

/**
 * The whole of the app's addressing, assembled by hand.
 *
 * Routes are plain modules rather than files a plugin scans, so there is no
 * generated tree to keep in step with the source and no second build plugin to
 * sit alongside the ones this app already runs. Everything except sign-in hangs
 * off the authenticated layout, which is what makes "signed in" a property of
 * the tree instead of a check each screen has to remember.
 */
const routeTree = rootRoute.addChildren([
  loginRoute,
  layoutRoute.addChildren([
    boardRoute,
    taskRoute,
    projectsRoute,
    filesRoute,
    apiKeysRoute,
  ]),
]);

/** The quiet moment between asking for a route and having it. */
const RoutePending = () => (
  <div className="flex min-h-40 items-center justify-center">
    <Spinner aria-label="Loading" className="size-4 text-muted-foreground" />
  </div>
);

/**
 * The router, created once and shared by the provider and the type registration
 * below.
 *
 * The cache goes into the router's context so a route can read or prefetch
 * through the same client the components use. Preloading on intent is worth its
 * cost here: the operator moves between the board and a task page constantly,
 * and the data behind each is small.
 */
export const router = createRouter({
  context: { queryClient },
  defaultPendingComponent: RoutePending,
  defaultPreload: "intent",
  routeTree,
  scrollRestoration: true,
});

/**
 * Teaches every `Link`, `navigate` and `useSearch` in the app about this exact
 * tree, so a path that does not exist and a search parameter that is not
 * declared are both compile errors rather than a page that quietly renders
 * nothing.
 */
declare module "@tanstack/react-router" {
  interface Register {
    router: typeof router;
  }
}
