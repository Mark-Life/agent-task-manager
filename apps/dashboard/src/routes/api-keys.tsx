import { createRoute, lazyRouteComponent } from "@tanstack/react-router";
import { RouteError } from "@/components/error-boundary";
import { layoutRoute } from "@/routes/layout";

/**
 * Keys are a person's own, so the screen is a list and a dialog and nothing
 * else — there is no detail page for a credential whose only readable fields
 * are on the row already.
 */
export const apiKeysRoute = createRoute({
  component: lazyRouteComponent(
    () => import("@/features/api-keys/api-keys"),
    "ApiKeys"
  ),
  errorComponent: RouteError,
  getParentRoute: () => layoutRoute,
  path: "/api-keys",
});
