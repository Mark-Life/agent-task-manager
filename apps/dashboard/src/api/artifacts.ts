import { useMutation, useQueryClient } from "@tanstack/react-query";
import type { ArtifactId, ProjectId, TaskId } from "@workspace/domain";
import { keys } from "@/api/keys";
import { apiMutation, apiQuery } from "@/api/query";
import type { ApiClientShape } from "@/api/runtime";
import { gatewayUrl } from "@/env";

type ArtifactClient = ApiClientShape["artifacts"];
type Promotion = Parameters<ArtifactClient["promote"]>[0]["payload"];

/** A file going into a task's own folder — the only one of the three mounts that is writable. */
export interface ArtifactUpload {
  readonly file: File;
  /** Relative to the task's folder, and the natural key: the same path replaces the file. */
  readonly path: string;
  readonly taskId: TaskId;
}

/** Keeping a file beyond the task that made it. */
export interface ArtifactPromotion {
  readonly artifactId: ArtifactId;
  readonly scope: Promotion["scope"];
  readonly taskId: TaskId;
}

/**
 * A task's files, most recently written first.
 *
 * Metadata only — the bytes are a separate read, because putting them in the
 * index would mean carrying a file through the cache on every list. `ext` is
 * what a renderer dispatches on; the server deliberately guesses no content
 * type.
 */
export const artifactsQuery = (taskId: TaskId) =>
  apiQuery(keys.artifacts(taskId), (client) =>
    client.artifacts.list({ params: { taskId } })
  );

/**
 * A project's shared folder, most recently written first.
 *
 * What a task's list cannot show: the material that outlives the task that
 * produced it — a document one run left for the next task in the project, and
 * the copies a promotion put there. One folder on disk, so one list here.
 */
export const projectArtifactsQuery = (projectId: ProjectId) =>
  apiQuery(keys.projectArtifacts(projectId), (client) =>
    client.artifacts.listProject({ params: { projectId } })
  );

/**
 * Where the bytes are, as a URL rather than a fetch.
 *
 * The content endpoint answers a raw octet stream, which is what `<a download>`
 * and an `<img src>` already know how to consume — pulling it through the typed
 * client would buffer a file in memory to hand the browser something it can
 * stream itself. Same-origin in development, where the value is empty.
 */
export const artifactContentUrl = (taskId: TaskId, artifactId: ArtifactId) =>
  `${gatewayUrl}/tasks/${taskId}/artifacts/${artifactId}/content`;

/** The multipart body the upload endpoint reads: the file, and where it goes. */
const uploadBody = (upload: ArtifactUpload) => {
  const body = new FormData();
  body.append("file", upload.file);
  body.append("path", upload.path);
  return body;
};

/**
 * Put a file in the task's folder.
 *
 * The whole list is refreshed rather than the one row patched in, because an
 * upload rescans the directory: it can replace a file at the same path and it
 * clears the provenance of everything a run produced there, so the rest of the
 * index is stale too.
 */
export const useUploadArtifact = () => {
  const queryClient = useQueryClient();
  return useMutation({
    ...apiMutation((upload: ArtifactUpload, client) =>
      client.artifacts.upload({
        params: { taskId: upload.taskId },
        payload: uploadBody(upload),
      })
    ),
    onSuccess: (_artifact, upload) =>
      queryClient.invalidateQueries({
        queryKey: keys.artifacts(upload.taskId),
      }),
  });
};

/**
 * Copy a file into the project's folder or the global one.
 *
 * The answer is the task's own row with its promotion stamped on it, not the
 * copy — the copy belongs to a folder this task's list does not show. A second
 * promotion of the same file is refused, which is why the button reads the stamp
 * rather than staying live.
 */
export const usePromoteArtifact = () => {
  const queryClient = useQueryClient();
  return useMutation({
    ...apiMutation((promotion: ArtifactPromotion, client) =>
      client.artifacts.promote({
        params: {
          artifactId: promotion.artifactId,
          taskId: promotion.taskId,
        },
        payload: { scope: promotion.scope },
      })
    ),
    onSuccess: (_artifact, promotion) =>
      queryClient.invalidateQueries({
        queryKey: keys.artifacts(promotion.taskId),
      }),
  });
};
