/**
 * The task's conversation, and the only channel that crosses sessions.
 *
 * Two operations, because there are only two: read the thread, add to it. No
 * edit and no delete — a comment is what a session said, and a thread that can
 * be rewritten is not a record of anything. The author is never in the body; it
 * comes off the credential.
 */

import { TaskId } from "@workspace/domain";
import { Schema } from "effect";
import {
  HttpApiEndpoint,
  HttpApiGroup,
  OpenApi,
} from "effect/unstable/httpapi";
import { InvalidInput, NotFound } from "../errors";
import { Comment, CommentAppend } from "../schemas/comment";
import { ReadAccess, TaskWriteAccess } from "../security";

/** The whole thread, oldest first — the order it is read in. */
const list = HttpApiEndpoint.get("list", "/tasks/:taskId/comments", {
  error: NotFound,
  params: { taskId: TaskId },
  success: Schema.Array(Comment),
})
  .middleware(ReadAccess)
  .annotate(OpenApi.Summary, "Read a task's thread");

/**
 * Say something on the task. This is how a run reports, how a person answers,
 * and how the next session finds out what happened while it was not running.
 */
const append = HttpApiEndpoint.post("append", "/tasks/:taskId/comments", {
  error: [InvalidInput, NotFound],
  params: { taskId: TaskId },
  payload: CommentAppend,
  success: Comment,
})
  .middleware(TaskWriteAccess)
  .annotate(OpenApi.Summary, "Post a comment on a task");

/** One thread per task, append only. */
export class CommentsGroup extends HttpApiGroup.make("comments")
  .add(list, append)
  .annotate(
    OpenApi.Description,
    "Comments: the task's conversation, across every session on it."
  ) {}
