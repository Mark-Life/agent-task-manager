import { createRoute } from "@tanstack/react-router";
import { RouteError } from "@/components/error-boundary";
import { ApiKeys } from "@/features/api-keys/api-keys";
import { layoutRoute } from "@/routes/layout";

/**
 * Keys are a person's own, so the screen is a list and a dialog and nothing
 * else — there is no detail page for a credential whose only readable fields
 * are on the row already.
 */
export const apiKeysRoute = createRoute({
  component: ApiKeys,
  errorComponent: RouteError,
  getParentRoute: () => layoutRoute,
  path: "/api-keys",
});
