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

import { ProjectEnvFileId, ProjectId } from "@workspace/domain";
import { Schema } from "effect";
import {
  HttpApiEndpoint,
  HttpApiGroup,
  OpenApi,
} from "effect/unstable/httpapi";
import { InvalidInput, NotFound } from "../errors";
import { Project, ProjectCreate, ProjectPatch } from "../schemas/project";
import {
  ProjectEnvFile,
  ProjectEnvFileContent,
  ProjectEnvFileSave,
} from "../schemas/project-env";
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

/**
 * The environment files a project hands to every run in its repo.
 *
 * All four are `admin`, and the listing is too. A worker run holds a
 * `task-write` token, and these endpoints reach every project's stored
 * credentials — a run is given its *own* project's files on disk, by the loop,
 * and there is no case for one asking the board for anybody's. Admin is the one
 * scope a run's token can never satisfy, so the ceiling does the work rather
 * than a check in a handler.
 *
 * Addressed by row id rather than by the path, even though the path is the
 * natural key. A repo-relative path has slashes in it, and putting one in a
 * path segment means a wildcard route and a caller that has to know how this
 * server decodes them; the id is opaque and the listing hands it over.
 */
const listEnv = HttpApiEndpoint.get("listEnv", "/projects/:projectId/env", {
  params: { projectId: ProjectId },
  success: Schema.Array(ProjectEnvFile),
})
  .middleware(AdminAccess)
  .annotate(OpenApi.Summary, "List a project's environment files");

/** One file, decrypted. The one operation in this API that returns a secret. */
const getEnv = HttpApiEndpoint.get(
  "getEnv",
  "/projects/:projectId/env/:fileId",
  {
    error: NotFound,
    params: { fileId: ProjectEnvFileId, projectId: ProjectId },
    success: ProjectEnvFileContent,
  }
)
  .middleware(AdminAccess)
  .annotate(OpenApi.Summary, "Read one environment file");

/** Save one at a path, creating it or replacing its text. */
const saveEnv = HttpApiEndpoint.put("saveEnv", "/projects/:projectId/env", {
  error: [InvalidInput, NotFound],
  params: { projectId: ProjectId },
  payload: ProjectEnvFileSave,
  success: ProjectEnvFile,
})
  .middleware(AdminAccess)
  .annotate(OpenApi.Summary, "Save an environment file");

/** Remove one. The next run simply does not get it. */
const deleteEnv = HttpApiEndpoint.delete(
  "deleteEnv",
  "/projects/:projectId/env/:fileId",
  {
    error: NotFound,
    params: { fileId: ProjectEnvFileId, projectId: ProjectId },
  }
)
  .middleware(AdminAccess)
  .annotate(OpenApi.Summary, "Delete an environment file");

/** Projects and their environment files, and nothing about the tasks inside them. */
export class ProjectsGroup extends HttpApiGroup.make("projects")
  .add(list, get, create, patch, remove)
  .add(listEnv, getEnv, saveEnv, deleteEnv)
  .annotate(
    OpenApi.Description,
    "Projects: repositories, areas of life, and the environment files a project's runs are given."
  ) {}
