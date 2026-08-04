import { useMutation, useQueryClient } from "@tanstack/react-query";
import type { TaskId } from "@workspace/domain";
import { keys } from "@/api/keys";
import { apiMutation, apiQuery } from "@/api/query";
import type { ApiClientShape } from "@/api/runtime";

type CommentAppend = Parameters<
  ApiClientShape["comments"]["append"]
>[0]["payload"];

/** Saying something on a task, and which task it lands on. */
export interface CommentDraft {
  readonly comment: CommentAppend;
  readonly taskId: TaskId;
}

/**
 * A task's whole conversation, oldest first — the order it is read in, and the
 * order the next session reads it in too. Every session on the task speaks
 * here, so the author on each row is what keeps several voices apart.
 */
export const commentsQuery = (taskId: TaskId) =>
  apiQuery(keys.comments(taskId), (client) =>
    client.comments.list({ params: { taskId } })
  );

/**
 * Post a comment.
 *
 * Only that task's thread is invalidated: a comment changes nothing about where
 * the card sits, and refreshing the board because somebody typed a sentence
 * would move cards under the reader for no reason. The author is not in the
 * body — the server takes it off the credential.
 */
export const useAppendComment = () => {
  const queryClient = useQueryClient();
  return useMutation({
    ...apiMutation((draft: CommentDraft, client) =>
      client.comments.append({
        params: { taskId: draft.taskId },
        payload: draft.comment,
      })
    ),
    onSuccess: (_comment, draft) =>
      queryClient.invalidateQueries({ queryKey: keys.comments(draft.taskId) }),
  });
};
