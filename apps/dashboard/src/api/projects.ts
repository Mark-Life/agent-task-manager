import { useMutation, useQueryClient } from "@tanstack/react-query";
import type { ProjectId } from "@workspace/domain";
import { boardsKey, taskListsKey } from "@/api/board-cache";
import { keys } from "@/api/keys";
import { apiMutation, apiQuery } from "@/api/query";
import type { ApiClientShape } from "@/api/runtime";

type ProjectClient = ApiClientShape["projects"];
type ProjectCreate = Parameters<ProjectClient["create"]>[0]["payload"];
type ProjectPatch = Parameters<ProjectClient["patch"]>[0]["payload"];

/** Editing one project: what to change, and which one. */
export interface ProjectEdit {
  readonly patch: ProjectPatch;
  readonly projectId: ProjectId;
}

/**
 * Every project in the workspace. Small, stable and read by the board filter,
 * the task form and the project screen alike, which is why it is one key rather
 * than one per screen.
 */
export const projectsQuery = () =>
  apiQuery(keys.projects(), (client) => client.projects.list());

/** One project. A project with no repository is an ordinary project, not a broken one. */
export const projectQuery = (projectId: ProjectId) =>
  apiQuery(keys.project(projectId), (client) =>
    client.projects.get({ params: { projectId } })
  );

/** File a new project. Only the name is required; the workspace comes off the credential. */
export const useCreateProject = () => {
  const queryClient = useQueryClient();
  return useMutation({
    ...apiMutation((payload: ProjectCreate, client) =>
      client.projects.create({ payload })
    ),
    onSuccess: () =>
      queryClient.invalidateQueries({ queryKey: keys.projects() }),
  });
};

/**
 * Change what a project says. Cards carry the project's name, so the boards go
 * stale with it — a rename that only reached the project screen would leave the
 * old name on every card until something else refetched.
 */
export const usePatchProject = () => {
  const queryClient = useQueryClient();
  return useMutation({
    ...apiMutation((edit: ProjectEdit, client) =>
      client.projects.patch({
        params: { projectId: edit.projectId },
        payload: edit.patch,
      })
    ),
    onSuccess: () =>
      Promise.all([
        queryClient.invalidateQueries({ queryKey: keys.projects() }),
        queryClient.invalidateQueries({ queryKey: boardsKey }),
      ]),
  });
};

/**
 * Remove a project. The tasks that pointed at it survive with no project rather
 * than being deleted, so every board and list is stale the moment this returns
 * and all of them are refreshed.
 */
export const useDeleteProject = () => {
  const queryClient = useQueryClient();
  return useMutation({
    ...apiMutation((projectId: ProjectId, client) =>
      client.projects.delete({ params: { projectId } })
    ),
    onSuccess: async (_deleted, projectId) => {
      queryClient.removeQueries({ queryKey: keys.project(projectId) });
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: keys.projects() }),
        queryClient.invalidateQueries({ queryKey: boardsKey }),
        queryClient.invalidateQueries({ queryKey: taskListsKey }),
      ]);
    },
  });
};
