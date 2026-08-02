/**
 * Conversations with the manager agent, over the same door the bot uses.
 *
 * A thread is not a board card and does not hang off one: a worker's session
 * belongs to the task it was dispatched for, and a conversation belongs to
 * nothing but itself. So this group is rooted at `/threads` rather than nested
 * under a task, and the one conversation is reachable from Telegram and from
 * anything holding a token — the same rows, the same turns, the same answers.
 *
 * Everything a thread owns nests under `/threads/:threadId`, for the reason
 * `/tasks/:taskId` does: the thread is proved once, at the top of each handler,
 * rather than in each of the reads below it.
 *
 * **Posting a message is the dispatch source.** It writes a row and stops. The
 * insert is what the loop is listening for, so an HTTP caller and the bot start
 * a turn by exactly the same means and there is no second path into one. What
 * comes back says whether the message starts a turn or joins one already
 * running; nothing here waits for an answer, which arrives as a message of its
 * own once the turn ends.
 *
 * No streaming endpoint. A turn is a run, and a run's timeline already streams
 * over the runs group — a second feed for chat would be a second answer to what
 * an agent did.
 */

import { ThreadId, ThreadStatus } from "@workspace/domain";
import { Schema } from "effect";
import {
  HttpApiEndpoint,
  HttpApiGroup,
  OpenApi,
} from "effect/unstable/httpapi";
import { InvalidInput, NotFound } from "../errors";
import { Run } from "../schemas/run";
import { RunCommand, RunTarget } from "../schemas/run-command";
import {
  Thread,
  ThreadCreate,
  ThreadDetail,
  ThreadMessageAppend,
  ThreadMessageCursor,
  ThreadMessagePage,
  ThreadMessagePosted,
  ThreadPatch,
} from "../schemas/thread";
import { ReadAccess, TaskWriteAccess } from "../security";

/** The largest page of a conversation the store will assemble in one query. */
const MAX_MESSAGE_PAGE = 500;

/** The most threads one list answers with. A thread list is a sidebar, not a report. */
const MAX_THREAD_PAGE = 100;

const pageSize = (maximum: number) =>
  Schema.optionalKey(
    Schema.Int.pipe(Schema.check(Schema.isBetween({ maximum, minimum: 1 })))
  );

/**
 * The conversations, most recently spoken in first — the order a sidebar shows
 * them and the order the index is built in. Archived ones are absent unless
 * asked for, because a retired thread is kept for its audit trail rather than
 * for the list.
 */
const list = HttpApiEndpoint.get("list", "/threads", {
  query: {
    limit: pageSize(MAX_THREAD_PAGE),
    offset: Schema.optionalKey(Schema.Natural),
    status: Schema.optionalKey(ThreadStatus),
  },
  success: Schema.Array(Thread),
})
  .middleware(ReadAccess)
  .annotate(OpenApi.Summary, "List the manager conversations");

/**
 * Open one. The same thing `/new` does in the bot, from either interface — and
 * a thread opened here belongs to no Telegram chat, so it is reachable by id
 * and never by being the chat's current one.
 */
const create = HttpApiEndpoint.post("create", "/threads", {
  error: InvalidInput,
  payload: ThreadCreate,
  success: Thread,
})
  .middleware(TaskWriteAccess)
  .annotate(OpenApi.Summary, "Open a conversation");

/** One conversation, and the turn running on it right now if there is one. */
const get = HttpApiEndpoint.get("get", "/threads/:threadId", {
  error: NotFound,
  params: { threadId: ThreadId },
  success: ThreadDetail,
})
  .middleware(ReadAccess)
  .annotate(OpenApi.Summary, "Get a conversation with its live turn");

/**
 * Retitle it, make it the one its chat is speaking to, or retire it. There is
 * no delete: the audit rows a conversation caused point at it, and a thread
 * that can be erased is a board history with a hole in it.
 */
const patch = HttpApiEndpoint.patch("patch", "/threads/:threadId", {
  error: [InvalidInput, NotFound],
  params: { threadId: ThreadId },
  payload: ThreadPatch,
  success: Thread,
})
  .middleware(TaskWriteAccess)
  .annotate(OpenApi.Summary, "Retitle, select or archive a conversation");

/** A page of what was said, oldest first — the order it is read in. */
const messages = HttpApiEndpoint.get(
  "messages",
  "/threads/:threadId/messages",
  {
    error: NotFound,
    params: { threadId: ThreadId },
    query: { ...ThreadMessageCursor, limit: pageSize(MAX_MESSAGE_PAGE) },
    success: ThreadMessagePage,
  }
)
  .middleware(ReadAccess)
  .annotate(OpenApi.Summary, "Read a page of a conversation");

/**
 * Say something. This is what starts a turn: the row is written, the loop reads
 * it, and the answer arrives as a message of its own.
 *
 * A message that lands while a turn is running is not held anywhere — it is
 * unread, and the next turn reads it with everything else that arrived, which
 * is why several of them become one prompt. `queued` says which of the two
 * happened, and a caller that will not wait stops the live turn.
 */
const postMessage = HttpApiEndpoint.post(
  "postMessage",
  "/threads/:threadId/messages",
  {
    error: [InvalidInput, NotFound],
    params: { threadId: ThreadId },
    payload: ThreadMessageAppend,
    success: ThreadMessagePosted,
  }
)
  .middleware(TaskWriteAccess)
  .annotate(OpenApi.Summary, "Post a message to a conversation");

/**
 * The thread's turns, newest first. One run each, so their timelines are read
 * back through the runs group rather than duplicated here.
 */
const runs = HttpApiEndpoint.get("runs", "/threads/:threadId/runs", {
  error: NotFound,
  params: { threadId: ThreadId },
  success: Schema.Array(Run),
})
  .middleware(ReadAccess)
  .annotate(OpenApi.Summary, "List a conversation's turns");

/**
 * Cut the live turn short, so what has been said since it started is answered
 * now rather than after it finishes.
 *
 * An intent on the orchestrator's queue, exactly as stopping a worker is:
 * nothing here touches a container. The stopped turn's run closes as
 * interrupted and the messages it never read are still unread, so the next turn
 * resumes the same conversation with them.
 */
const stop = HttpApiEndpoint.post("stop", "/threads/:threadId/stop", {
  error: NotFound,
  params: { threadId: ThreadId },
  payload: RunTarget,
  success: RunCommand,
})
  .middleware(TaskWriteAccess)
  .annotate(OpenApi.Summary, "Ask the orchestrator to stop a live turn");

/** Conversations with the manager, and the turns they cause. */
export class ThreadsGroup extends HttpApiGroup.make("threads")
  .add(list, create, get, patch, messages, postMessage, runs, stop)
  .annotate(
    OpenApi.Description,
    "Threads: conversations with the manager agent, and the turns they cause."
  ) {}
