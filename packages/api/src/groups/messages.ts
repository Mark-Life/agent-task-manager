/**
 * The task's conversation, and the only channel that crosses sessions.
 *
 * Two operations, because there are only two: read the thread, post to it. No
 * edit and no delete — a message is what a session said, and a thread that can
 * be rewritten is not a record of anything. The author is never in the body; it
 * comes off the credential.
 *
 * These were `/tasks/:taskId/comments` and `comments.list` / `comments.append`
 * until the name became part of what an external agent is handed. The old
 * spellings are gone rather than deprecated: everything that calls them — the
 * gateway, the dashboard, the bot and the agents' MCP tools — ships from this
 * repository in one deploy, and an alias would go on teaching the word the
 * schema is supposed to stop teaching.
 */

import { TaskId } from "@workspace/domain";
import { Schema } from "effect";
import {
  HttpApiEndpoint,
  HttpApiGroup,
  OpenApi,
} from "effect/unstable/httpapi";
import { InvalidInput, NotFound } from "../errors";
import { TaskMessage, TaskMessagePost } from "../schemas/task-message";
import { ReadAccess, TaskWriteAccess } from "../security";

/** The whole thread, oldest first — the order it is read in. */
const list = HttpApiEndpoint.get("list", "/tasks/:taskId/messages", {
  error: NotFound,
  params: { taskId: TaskId },
  success: Schema.Array(TaskMessage),
})
  .middleware(ReadAccess)
  .annotate(OpenApi.Summary, "Read a task's thread");

/**
 * Say something on the task. This is how a run reports, how a person answers,
 * and how the next session finds out what happened while it was not running.
 */
const post = HttpApiEndpoint.post("post", "/tasks/:taskId/messages", {
  error: [InvalidInput, NotFound],
  params: { taskId: TaskId },
  payload: TaskMessagePost,
  success: TaskMessage,
})
  .middleware(TaskWriteAccess)
  .annotate(OpenApi.Summary, "Post a message on a task");

/** One thread per task, append only. */
export class MessagesGroup extends HttpApiGroup.make("messages")
  .add(list, post)
  .annotate(
    OpenApi.Description,
    "Task messages: the task's conversation, across every session on it. Renamed from `comments` on 2026-08-08 — a clean break, with no alias on the old paths or operation ids."
  ) {}
