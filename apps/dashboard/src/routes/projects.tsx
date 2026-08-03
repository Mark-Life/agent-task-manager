import { createRoute } from "@tanstack/react-router";
import { RouteError } from "@/components/error-boundary";
import { Projects } from "@/features/projects/projects";
import { layoutRoute } from "@/routes/layout";

/**
 * Projects have no filter, no selection and no detail page: a project is a name
 * and sometimes a repository, and everything that can be done to one is done in
 * place. So the route is the screen and nothing else.
 */
export const projectsRoute = createRoute({
  component: Projects,
  errorComponent: RouteError,
  getParentRoute: () => layoutRoute,
  path: "/projects",
});
