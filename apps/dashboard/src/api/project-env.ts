import { useMutation, useQueryClient } from "@tanstack/react-query";
import type {
  EnvFilePath,
  ProjectEnvFileId,
  ProjectId,
} from "@workspace/domain";
import { keys } from "@/api/keys";
import { apiMutation, apiQuery } from "@/api/query";

/** Saving one file: where it goes, its whole text, and which project it belongs to. */
export interface ProjectEnvSave {
  readonly content: string;
  readonly path: EnvFilePath;
  readonly projectId: ProjectId;
}

/** Removing one file. */
export interface ProjectEnvRef {
  readonly fileId: ProjectEnvFileId;
  readonly projectId: ProjectId;
}

/**
 * The paths a project injects, and when each last changed. Never their content:
 * the endpoint has nowhere to put it, so the sidebar cannot hold a secret in
 * memory it did not ask for.
 */
export const projectEnvFilesQuery = (projectId: ProjectId) =>
  apiQuery(keys.projectEnvFiles(projectId), (client) =>
    client.projects.listEnv({ params: { projectId } })
  );

/**
 * One file's text, fetched only when the editor opens it.
 *
 * Its own key under the file's id, so closing the editor and opening a
 * different file is a different query rather than a refetch of the same one —
 * and so `invalidateQueries` on the project refreshes both the listing and
 * whatever is open.
 */
export const projectEnvFileQuery = (ref: ProjectEnvRef) =>
  apiQuery(keys.projectEnvFile(ref.projectId, ref.fileId), (client) =>
    client.projects.getEnv({
      params: { fileId: ref.fileId, projectId: ref.projectId },
    })
  );

/**
 * Save a file at a path. An upsert: the path is the key, so the editor saves
 * without knowing whether a row for it already exists.
 */
export const useSaveProjectEnvFile = () => {
  const queryClient = useQueryClient();
  return useMutation({
    ...apiMutation((save: ProjectEnvSave, client) =>
      client.projects.saveEnv({
        params: { projectId: save.projectId },
        payload: { content: save.content, path: save.path },
      })
    ),
    onSuccess: (saved, save) =>
      Promise.all([
        queryClient.invalidateQueries({
          queryKey: keys.projectEnvFiles(save.projectId),
        }),
        queryClient.invalidateQueries({
          queryKey: keys.projectEnvFile(save.projectId, saved.id),
        }),
      ]),
  });
};

/** Remove a file. The next run of this project's tasks simply does not get it. */
export const useDeleteProjectEnvFile = () => {
  const queryClient = useQueryClient();
  return useMutation({
    ...apiMutation((ref: ProjectEnvRef, client) =>
      client.projects.deleteEnv({
        params: { fileId: ref.fileId, projectId: ref.projectId },
      })
    ),
    onSuccess: async (_deleted, ref) => {
      queryClient.removeQueries({
        queryKey: keys.projectEnvFile(ref.projectId, ref.fileId),
      });
      await queryClient.invalidateQueries({
        queryKey: keys.projectEnvFiles(ref.projectId),
      });
    },
  });
};
