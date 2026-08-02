/**
 * Projects: the places tasks belong to.
 *
 * A project with no repository is an ordinary project — a trip, a piece of
 * writing, an area of life — and that is the whole of the difference here: a
 * run either clones something or gets an empty scratch directory. Nothing in
 * this group branches on it.
 *
 * The workspace is never in a path or a body. It comes off the credential, so a
 * caller cannot name a workspace it cannot read.
 */

import { ProjectId } from "@workspace/domain";
import { Schema } from "effect";
import {
  HttpApiEndpoint,
  HttpApiGroup,
  OpenApi,
} from "effect/unstable/httpapi";
import { InvalidInput, NotFound } from "../errors";
import { Project, ProjectCreate, ProjectPatch } from "../schemas/project";
import { AdminAccess, ReadAccess, TaskWriteAccess } from "../security";

/** Every project in the workspace. */
const list = HttpApiEndpoint.get("list", "/projects", {
  success: Schema.Array(Project),
})
  .middleware(ReadAccess)
  .annotate(OpenApi.Summary, "List projects");

/** One project. */
const get = HttpApiEndpoint.get("get", "/projects/:projectId", {
  error: NotFound,
  params: { projectId: ProjectId },
  success: Project,
})
  .middleware(ReadAccess)
  .annotate(OpenApi.Summary, "Get a project");

/** File a new one. Only the name is required. */
const create = HttpApiEndpoint.post("create", "/projects", {
  error: InvalidInput,
  payload: ProjectCreate,
  success: Project,
})
  .middleware(TaskWriteAccess)
  .annotate(OpenApi.Summary, "Create a project");

/** Change what a project says. The workspace is not among the fields. */
const patch = HttpApiEndpoint.patch("patch", "/projects/:projectId", {
  error: [InvalidInput, NotFound],
  params: { projectId: ProjectId },
  payload: ProjectPatch,
  success: Project,
})
  .middleware(TaskWriteAccess)
  .annotate(OpenApi.Summary, "Update a project");

/**
 * Remove it. Admin, because a project is where a body of work lives and the
 * tasks pointing at it are the thing at risk.
 */
const remove = HttpApiEndpoint.delete("delete", "/projects/:projectId", {
  error: NotFound,
  params: { projectId: ProjectId },
})
  .middleware(AdminAccess)
  .annotate(OpenApi.Summary, "Delete a project");

/** Projects, and nothing about the tasks inside them. */
export class ProjectsGroup extends HttpApiGroup.make("projects")
  .add(list, get, create, patch, remove)
  .annotate(
    OpenApi.Description,
    "Projects: repositories, and areas of life."
  ) {}
