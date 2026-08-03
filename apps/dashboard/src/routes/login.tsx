import { createRoute } from "@tanstack/react-router";
import { RouteError } from "@/components/error-boundary";
import { SignIn } from "@/features/auth/sign-in";
import { rootRoute } from "@/routes/root";

/**
 * The only address that does not sit behind a session.
 *
 * It hangs off the root rather than off the authenticated layout on purpose:
 * the layout redirects anybody without a session here, and a sign-in screen
 * nested inside that redirect would chase its own tail. Nothing is validated
 * out of the URL — a return path would be a way to bounce somebody through this
 * page to an address of a stranger's choosing.
 */
export const loginRoute = createRoute({
  component: SignIn,
  errorComponent: RouteError,
  getParentRoute: () => rootRoute,
  path: "/login",
});
