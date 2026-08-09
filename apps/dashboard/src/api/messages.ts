import { useMutation, useQueryClient } from "@tanstack/react-query";
import type { TaskId } from "@workspace/domain";
import { keys } from "@/api/keys";
import { apiMutation, apiQuery } from "@/api/query";
import type { ApiClientShape } from "@/api/runtime";

type TaskMessagePost = Parameters<
  ApiClientShape["messages"]["post"]
>[0]["payload"];

/** Saying something on a task, and which task it lands on. */
export interface TaskMessageDraft {
  readonly message: TaskMessagePost;
  readonly taskId: TaskId;
}

/**
 * A task's whole conversation, oldest first — the order it is read in, and the
 * order the next session reads it in too. Every session on the task speaks
 * here, so the author on each row is what keeps several voices apart.
 */
export const taskMessagesQuery = (taskId: TaskId) =>
  apiQuery(keys.taskMessages(taskId), (client) =>
    client.messages.list({ params: { taskId } })
  );

/**
 * Post a message.
 *
 * Only that task's thread is invalidated: a message changes nothing about where
 * the card sits, and refreshing the board because somebody typed a sentence
 * would move cards under the reader for no reason. The author is not in the
 * body — the server takes it off the credential.
 */
export const usePostTaskMessage = () => {
  const queryClient = useQueryClient();
  return useMutation({
    ...apiMutation((draft: TaskMessageDraft, client) =>
      client.messages.post({
        params: { taskId: draft.taskId },
        payload: draft.message,
      })
    ),
    onSuccess: (_message, draft) =>
      queryClient.invalidateQueries({
        queryKey: keys.taskMessages(draft.taskId),
      }),
  });
};
