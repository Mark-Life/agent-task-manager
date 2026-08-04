/**
 * A conversation with the manager agent on the wire, and its messages.
 *
 * The entity is the domain's, so a thread the bot wrote and a thread the
 * dashboard opened are one shape rather than two views of one table. What is
 * added here is only what an HTTP caller cannot derive: the live turn beside a
 * thread, and whether a posted message started a turn or joined one already
 * running.
 *
 * The provider's own session id is deliberately absent from every shape below.
 * A turn is a run, a run has an `agent_session`, and that row is where the id
 * the provider handed back lives — a copy on the thread would be a second
 * answer to which conversation the provider is resuming.
 */

import {
  ChatMessage as DomainChatMessage,
  ChatThread as DomainChatThread,
  RunId,
} from "@workspace/domain";
import { Schema } from "effect";

/** One conversation with the manager, exactly as the store holds it. */
export const Thread = DomainChatThread.annotate({ identifier: "Thread" });

export interface Thread extends Schema.Schema.Type<typeof Thread> {}

/**
 * A thread with the one thing a reader always needs beside it: the turn running
 * on it right now, if there is one.
 *
 * Named by id rather than handed over whole, the way a task's live run is: a
 * caller that wants the turn's economics asks the runs group for it. A null
 * `liveRunId` on a thread whose last message is unanswered is the real state a
 * dashboard draws differently — waiting for a slot, rather than being answered.
 */
export const ThreadDetail = Schema.Struct({
  liveRunId: Schema.NullOr(RunId),
  thread: Thread,
}).annotate({ identifier: "ThreadDetail" });

export interface ThreadDetail extends Schema.Schema.Type<typeof ThreadDetail> {}

/**
 * What opening a conversation takes.
 *
 * The user is absent on purpose: a thread speaks for whoever the credential
 * names, so no caller can open a conversation in somebody else's name. The
 * Telegram chat is absent too — a thread opened over HTTP belongs to no chat,
 * and a body that could name one would let an API caller take the currency of a
 * chat it never spoke in.
 */
export const ThreadCreate = Schema.Struct({
  /** Which harness answers the thread. Absent means `claude`. */
  provider: Schema.optionalKey(DomainChatThread.fields.provider),
  title: Schema.optionalKey(DomainChatThread.fields.title),
}).annotate({ identifier: "ThreadCreate" });

export interface ThreadCreate extends Schema.Schema.Type<typeof ThreadCreate> {}

/**
 * The three things about a thread that can change, and nothing else: its title,
 * whether it is the one its chat is speaking to, and whether it is retired.
 *
 * `status` accepts only `archived`, because the way back is to make the thread
 * current again — which is a property of a Telegram chat, so a thread that
 * never had one has no way back and saying otherwise in the type would be a
 * promise the store cannot keep. Asking for both at once is refused rather than
 * ordered: an archived thread that is still current is a row the database
 * itself will not hold.
 */
export const ThreadPatch = Schema.Struct({
  /** Make this the thread its chat is speaking to. Only `true` — currency moves, it is not dropped. */
  isCurrent: Schema.optionalKey(Schema.Literal(true)),
  /** Retire it from the list. Nothing is deleted: audit rows point at a thread. */
  status: Schema.optionalKey(Schema.Literal("archived")),
  title: Schema.optionalKey(DomainChatThread.fields.title),
}).annotate({ identifier: "ThreadPatch" });

export interface ThreadPatch extends Schema.Schema.Type<typeof ThreadPatch> {}

/** One message in a thread, in either direction, exactly as the store holds it. */
export const ThreadMessage = DomainChatMessage.annotate({
  identifier: "ThreadMessage",
});

export interface ThreadMessage
  extends Schema.Schema.Type<typeof ThreadMessage> {}

/**
 * What saying something takes.
 *
 * Only the words. The speaker is the credential's, the role is `user` because
 * the manager's own answers are written by the run that produced them, and how
 * the message arrived is `api` because that is what came over HTTP — three
 * facts about the request, none of which a body should be able to claim.
 */
export const ThreadMessageAppend = Schema.Struct({
  body: DomainChatMessage.fields.body,
}).annotate({ identifier: "ThreadMessageAppend" });

export interface ThreadMessageAppend
  extends Schema.Schema.Type<typeof ThreadMessageAppend> {}

/**
 * A page of a conversation, oldest first — the order it is read in.
 *
 * `nextOffset` is what to ask for next and `null` means the page reached the
 * end of what exists, which on a thread being answered is not the end of the
 * conversation. An offset rather than a `(createdAt, id)` cursor because the
 * page is walked forwards from the beginning and a conversation is append-only:
 * nothing is inserted behind a reader to shift the window under it.
 */
export const ThreadMessagePage = Schema.Struct({
  messages: Schema.Array(ThreadMessage),
  nextOffset: Schema.NullOr(Schema.Natural),
}).annotate({ identifier: "ThreadMessagePage" });

export interface ThreadMessagePage
  extends Schema.Schema.Type<typeof ThreadMessagePage> {}

/**
 * What came of saying it: the row, and whether it has to wait.
 *
 * `queued` is false when this message is the one that starts a turn and true
 * when a turn is already running on the thread. A queued message is not held
 * anywhere — it is unread, and the next turn reads it with everything else that
 * arrived, which is why several of them become one prompt rather than several
 * turns. A caller that wants it answered now stops the live turn.
 */
export const ThreadMessagePosted = Schema.Struct({
  message: ThreadMessage,
  queued: Schema.Boolean,
}).annotate({ identifier: "ThreadMessagePosted" });

export interface ThreadMessagePosted
  extends Schema.Schema.Type<typeof ThreadMessagePosted> {}

/**
 * How many messages a page returns when the caller names no limit. One screen
 * of a conversation plus room to scroll, so the common case is one request.
 */
export const DEFAULT_MESSAGE_PAGE = 50;

/**
 * How many conversations a list returns when the caller names no limit. A
 * sidebar's worth: the ones spoken in recently, not the whole history.
 */
export const DEFAULT_THREAD_PAGE = 20;

/** How far into a thread a request has already read. */
export const ThreadMessageCursor = {
  /** Skip this many messages from the start of the conversation. */
  offset: Schema.optionalKey(Schema.Natural),
} as const;
