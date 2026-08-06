/**
 * Conversations with the manager agent, one current per Telegram chat and any
 * number opened from elsewhere.
 *
 * A thread is the conversation's identity and the audit log points at it, so
 * nothing here deletes one. Opening a new conversation drops the currency of
 * the old thread and keeps its rows.
 *
 * A thread is also a dispatch source: {@link awaitingReply} is the queue the
 * loop polls, and the claim that follows is a worker's — a quota check, a pool
 * slot, a lease and a run row.
 *
 * No audit rows and no actor. A chat is not board state: every board write a
 * conversation causes goes over the gateway, where the manager's actor already
 * carries this thread's id, so the conversation is named on the row it caused
 * rather than on a row of its own.
 */

import type {
  SessionProvider,
  TelegramChatId,
  ThreadId,
  ThreadStatus,
  UserId,
  WorkspaceId,
} from "@workspace/domain";
import { LIVE_RUN_STATUSES, newThreadId } from "@workspace/domain";
import {
  and,
  asc,
  desc,
  eq,
  getTableColumns,
  inArray,
  min,
  ne,
  notExists,
  sql,
} from "drizzle-orm";
import { Context, Effect, Layer } from "effect";
import { Database } from "../client";
import { ChatThreadInsert, ChatThreadUpdate, decodeChatThread } from "../rows";
import { agentSession } from "../schema/agent-session";
import { chatMessage, chatThread } from "../schema/chat";
import { run } from "../schema/run";
import {
  decodeMany,
  decodeWritten,
  encodeWrite,
  execute,
  firstRow,
  InvalidInput,
  unauditedTransaction,
} from "./audit";

/** Reads addressed by id match one row; the limit says so to the planner. */
const ONE = 1;

/** How many threads a chat's list returns unless told otherwise. */
const DEFAULT_LIMIT = 20;

/**
 * How many threads one dispatch poll considers. The pool admits one chat turn
 * at a time, so reading more than a handful is work thrown away.
 */
const QUEUE_LIMIT = 20;

/** How much of the opening message becomes the thread's title. */
export const THREAD_TITLE_MAX_CHARS = 60;

const ENTITY = "chat_thread";

/**
 * A chat thread is never addressed by id alone: every query names its
 * workspace. Spelled in full because `ThreadRef` already means a task's comment
 * thread in this package.
 */
export interface ChatThreadRef {
  readonly id: ThreadId;
  readonly workspaceId: WorkspaceId;
}

/** Which chat, in which workspace. The pair every thread is scoped by. */
export interface ChatRef {
  readonly chatId: TelegramChatId;
  readonly workspaceId: WorkspaceId;
}

/**
 * What opening a conversation needs. The provider is named rather than defaulted
 * here: the bot reads which harness the manager talks to from its own config,
 * and a thread that silently opened against a different one would resume
 * against a session the other provider never wrote.
 */
export interface ChatThreadOpen {
  /** Absent on a thread opened outside Telegram, which no chat owns. */
  readonly chatId?: TelegramChatId | null;
  readonly provider: SessionProvider;
  readonly title?: string | null;
  readonly userId: UserId;
  readonly workspaceId: WorkspaceId;
}

const liveStatuses = [...LIVE_RUN_STATUSES];

/** The thread's own columns, named so a join can select them and nothing else. */
const threadColumns = getTableColumns(chatThread);

/**
 * The newest session on the thread. Its watermark is what the thread has
 * already been shown: an older session's is not, because a provider switch or a
 * session that could not be resumed opens a new one whose null watermark
 * deliberately means "start from the beginning of the conversation".
 */
const newestSessionId = sql`(
  select newest.id
  from ${agentSession} as newest
  where newest.workspace_id = ${chatThread.workspaceId}
    and newest.thread_id = ${chatThread.id}
  order by newest.created_at desc, newest.id desc
  limit 1)`;

/**
 * A message the newest session has not been shown.
 *
 * The message's timestamp is truncated to milliseconds before it is compared,
 * because a watermark comes back through the domain's instant, which is
 * millisecond-precise, while the column keeps microseconds. Without the
 * truncation the row a session was just shown still reads as newer than the
 * watermark that names it, and the thread would be dispatched forever with
 * nothing new to say.
 *
 * Parenthesized as a whole: the surrounding `and` does not bracket what it is
 * given, and `or` binds looser than `and`, so an unwrapped disjunction would
 * silently widen the query it sits in.
 */
const unread = sql`(${agentSession.unreadWatermarkAt} is null
  or (date_trunc('milliseconds', ${chatMessage.createdAt}), ${chatMessage.id})
     > (${agentSession.unreadWatermarkAt}, ${agentSession.unreadWatermarkId}))`;

/** Clips an opening message down to what a thread list can show on one line. */
const titleOf = (title: string | null | undefined) =>
  title === null || title === undefined
    ? null
    : title.slice(0, THREAD_TITLE_MAX_CHARS);

const make = Effect.gen(function* () {
  const db = yield* Database;
  const inTransaction = unauditedTransaction(db);

  const refOf = (ref: ChatThreadRef) =>
    and(eq(chatThread.workspaceId, ref.workspaceId), eq(chatThread.id, ref.id));

  const chatOf = (ref: ChatRef) =>
    and(
      eq(chatThread.workspaceId, ref.workspaceId),
      eq(chatThread.chatId, ref.chatId)
    );

  /**
   * Opens a fresh conversation and makes it the chat's current one, dropping
   * the currency of whatever held it. Both statements are one transaction
   * because the partial unique index allows exactly one current thread per
   * chat, so the clear has to be committed with the insert or not at all.
   *
   * The old thread stays `active`: it is not finished, it is merely no longer
   * the one being spoken to, and `/switch` brings it back.
   */
  const open = Effect.fn("ChatThreadRepo.open")(function* (
    input: ChatThreadOpen
  ) {
    yield* Effect.annotateCurrentSpan({ workspaceId: input.workspaceId });

    const values = yield* encodeWrite({
      entity: ENTITY,
      schema: ChatThreadInsert,
      value: {
        chatId: input.chatId ?? null,
        id: newThreadId(),
        isCurrent: true,
        provider: input.provider,
        status: "active",
        title: titleOf(input.title),
        userId: input.userId,
        workspaceId: input.workspaceId,
      },
    });

    return yield* inTransaction(
      { operation: "ChatThreadRepo.open", table: ENTITY },
      (tx) =>
        Effect.gen(function* () {
          // Only a chat has a current thread, so a thread nobody chatted from
          // takes currency from nothing.
          if (input.chatId !== undefined && input.chatId !== null) {
            yield* execute(
              "ChatThreadRepo.open",
              tx
                .update(chatThread)
                .set({ isCurrent: false })
                .where(
                  and(
                    chatOf({
                      chatId: input.chatId,
                      workspaceId: input.workspaceId,
                    }),
                    eq(chatThread.isCurrent, true)
                  )
                )
            );
          }

          const rows = yield* execute(
            "ChatThreadRepo.open",
            tx.insert(chatThread).values(values).returning()
          );

          return yield* decodeWritten({
            decode: decodeChatThread,
            entity: ENTITY,
            operation: "ChatThreadRepo.open",
            rows,
          });
        })
    );
  });

  /**
   * The chat's current conversation, or null when it has never had one. Null is
   * an ordinary answer rather than a failure: the first message in a chat
   * arrives before any thread exists, and the caller opens one.
   */
  const current = Effect.fn("ChatThreadRepo.current")(function* (
    options: ChatRef
  ) {
    yield* Effect.annotateCurrentSpan({ workspaceId: options.workspaceId });

    const rows = yield* execute(
      "ChatThreadRepo.current",
      db
        .select()
        .from(chatThread)
        .where(and(chatOf(options), eq(chatThread.isCurrent, true)))
        .limit(ONE)
    );

    const [row] = rows;
    if (row === undefined) {
      return null;
    }

    return yield* decodeWritten({
      decode: decodeChatThread,
      entity: ENTITY,
      operation: "ChatThreadRepo.current",
      rows,
    });
  });

  /** One thread by id, scoped. */
  const byId = Effect.fn("ChatThreadRepo.byId")(function* (
    options: ChatThreadRef
  ) {
    yield* Effect.annotateCurrentSpan({
      threadId: options.id,
      workspaceId: options.workspaceId,
    });

    const rows = yield* execute(
      "ChatThreadRepo.byId",
      db.select().from(chatThread).where(refOf(options)).limit(ONE)
    );

    yield* firstRow({ entity: ENTITY, id: options.id, rows });

    return yield* decodeWritten({
      decode: decodeChatThread,
      entity: ENTITY,
      operation: "ChatThreadRepo.byId",
      rows,
    });
  });

  /**
   * A chat's threads, most recently spoken in first — the order `/threads`
   * lists them and the order the index is built in.
   */
  const listForChat = Effect.fn("ChatThreadRepo.listForChat")(function* (
    options: ChatRef & {
      readonly limit?: number;
      readonly offset?: number;
    }
  ) {
    yield* Effect.annotateCurrentSpan({ workspaceId: options.workspaceId });

    const rows = yield* execute(
      "ChatThreadRepo.listForChat",
      db
        .select()
        .from(chatThread)
        .where(chatOf(options))
        .orderBy(desc(chatThread.lastMessageAt), desc(chatThread.id))
        .limit(options.limit ?? DEFAULT_LIMIT)
        .offset(options.offset ?? 0)
    );

    return yield* decodeMany({
      decode: decodeChatThread,
      entity: ENTITY,
      rows,
    });
  });

  /**
   * Every conversation in the workspace, most recently spoken in first.
   *
   * The read a sidebar asks for, and the one {@link listForChat} cannot serve:
   * a thread opened over HTTP has no chat id and so belongs to no chat's list,
   * while the same thread is reachable from both interfaces.
   */
  const listForWorkspace = Effect.fn("ChatThreadRepo.listForWorkspace")(
    function* (options: {
      readonly limit?: number;
      readonly offset?: number;
      readonly status?: ThreadStatus;
      readonly workspaceId: WorkspaceId;
    }) {
      yield* Effect.annotateCurrentSpan({ workspaceId: options.workspaceId });

      const rows = yield* execute(
        "ChatThreadRepo.listForWorkspace",
        db
          .select()
          .from(chatThread)
          .where(
            and(
              eq(chatThread.workspaceId, options.workspaceId),
              options.status === undefined
                ? undefined
                : eq(chatThread.status, options.status)
            )
          )
          .orderBy(desc(chatThread.lastMessageAt), desc(chatThread.id))
          .limit(options.limit ?? DEFAULT_LIMIT)
          .offset(options.offset ?? 0)
      );

      return yield* decodeMany({
        decode: decodeChatThread,
        entity: ENTITY,
        rows,
      });
    }
  );

  /**
   * The threads with something to answer: an active thread holding a user
   * message the newest session on it has not been shown, and no live turn of
   * its own. This is the chat half of the dispatch queue, and it is a query
   * rather than a queue in memory for the reason the board column is — a queue
   * held in a process is dropped when the process restarts.
   *
   * Ordered by the oldest unread message, so the person who has been waiting
   * longest is answered first. The watermark comparison is the `(created_at,
   * id)` tuple the thread is ordered by, and a session that has been shown
   * nothing matches every message it has.
   */
  const awaitingReply = Effect.fn("ChatThreadRepo.awaitingReply")(
    function* (options: {
      readonly limit?: number;
      readonly workspaceId: WorkspaceId;
    }) {
      yield* Effect.annotateCurrentSpan({ workspaceId: options.workspaceId });

      const rows = yield* execute(
        "ChatThreadRepo.awaitingReply",
        db
          .select(threadColumns)
          .from(chatThread)
          .innerJoin(
            chatMessage,
            and(
              eq(chatMessage.workspaceId, chatThread.workspaceId),
              eq(chatMessage.threadId, chatThread.id),
              eq(chatMessage.role, "user")
            )
          )
          .leftJoin(agentSession, eq(agentSession.id, newestSessionId))
          .where(
            and(
              eq(chatThread.workspaceId, options.workspaceId),
              eq(chatThread.status, "active"),
              unread,
              notExists(
                db
                  .select({ live: sql`1` })
                  .from(run)
                  .where(
                    and(
                      eq(run.workspaceId, chatThread.workspaceId),
                      eq(run.threadId, chatThread.id),
                      inArray(run.status, liveStatuses)
                    )
                  )
              )
            )
          )
          .groupBy(chatThread.id)
          .orderBy(asc(min(chatMessage.createdAt)))
          .limit(options.limit ?? QUEUE_LIMIT)
      );

      return yield* decodeMany({
        decode: decodeChatThread,
        entity: ENTITY,
        rows,
      });
    }
  );

  /**
   * Makes one thread the current one for a chat, and the row is locked for the
   * length of the swap.
   *
   * Which chat is the caller's to say only when the thread has none. A named
   * `chatId` on a thread opened outside Telegram *binds* it to that chat —
   * which is what resuming a dashboard conversation from Telegram means, and
   * what makes the answer to its next turn deliverable, since a turn is
   * answered into `chat_id` and nowhere else. A thread that already belongs to
   * a chat keeps it: moving one would send another chat's answers to whoever
   * tapped last, so the swap is refused instead.
   *
   * Called with no `chatId` — the dashboard's *Make current* — a chat-less
   * thread is refused, because currency is a property of a chat and there is
   * no chat to hold it.
   */
  const setCurrent = Effect.fn("ChatThreadRepo.setCurrent")(function* (
    options: ChatThreadRef & { readonly chatId?: TelegramChatId }
  ) {
    yield* Effect.annotateCurrentSpan({
      threadId: options.id,
      workspaceId: options.workspaceId,
    });

    return yield* inTransaction(
      { operation: "ChatThreadRepo.setCurrent", table: ENTITY },
      (tx) =>
        Effect.gen(function* () {
          const locked = yield* execute(
            "ChatThreadRepo.setCurrent",
            tx
              .select({ chatId: chatThread.chatId })
              .from(chatThread)
              .where(refOf(options))
              .limit(ONE)
              .for("update")
          );

          const target = yield* firstRow({
            entity: ENTITY,
            id: options.id,
            rows: locked,
          });

          if (
            target.chatId !== null &&
            options.chatId !== undefined &&
            target.chatId !== options.chatId
          ) {
            return yield* Effect.fail(
              new InvalidInput({
                cause: "that conversation belongs to another chat",
                entity: ENTITY,
              })
            );
          }

          const chatId = target.chatId ?? options.chatId ?? null;

          // Currency is a property of a chat. A thread opened from the
          // dashboard that nobody has claimed has none to be current in, and
          // saying so is better than an update that silently matches nothing.
          if (chatId === null) {
            return yield* Effect.fail(
              new InvalidInput({
                cause: "a thread with no chat cannot be the current one",
                entity: ENTITY,
              })
            );
          }

          // Before the row is bound to the chat, not after: the partial unique
          // index allows one current thread per chat, and a thread opened
          // elsewhere arrives already carrying `is_current`.
          yield* execute(
            "ChatThreadRepo.setCurrent",
            tx
              .update(chatThread)
              .set({ isCurrent: false })
              .where(
                and(
                  chatOf({ chatId, workspaceId: options.workspaceId }),
                  eq(chatThread.isCurrent, true),
                  ne(chatThread.id, options.id)
                )
              )
          );

          const rows = yield* execute(
            "ChatThreadRepo.setCurrent",
            tx
              .update(chatThread)
              .set({ chatId, isCurrent: true, status: "active" })
              .where(refOf(options))
              .returning()
          );

          return yield* decodeWritten({
            decode: decodeChatThread,
            entity: ENTITY,
            operation: "ChatThreadRepo.setCurrent",
            rows,
          });
        })
    );
  });

  /**
   * Renames a conversation. The first message titles an untitled thread on its
   * own, so this is only ever someone disagreeing with what it chose — clipped
   * to the same width, because the thread list has the same line either way.
   */
  const retitle = Effect.fn("ChatThreadRepo.retitle")(function* (
    options: ChatThreadRef & { readonly title: string | null }
  ) {
    yield* Effect.annotateCurrentSpan({
      threadId: options.id,
      workspaceId: options.workspaceId,
    });

    const values = yield* encodeWrite({
      entity: ENTITY,
      schema: ChatThreadUpdate,
      value: { title: titleOf(options.title) },
    });

    const rows = yield* execute(
      "ChatThreadRepo.retitle",
      db.update(chatThread).set(values).where(refOf(options)).returning()
    );

    yield* firstRow({ entity: ENTITY, id: options.id, rows });

    return yield* decodeWritten({
      decode: decodeChatThread,
      entity: ENTITY,
      operation: "ChatThreadRepo.retitle",
      rows,
    });
  });

  /**
   * Retires a thread from the list without erasing it. Currency is dropped in
   * the same statement, because the row's CHECK refuses an archived thread that
   * is still current.
   */
  const archive = Effect.fn("ChatThreadRepo.archive")(function* (
    options: ChatThreadRef
  ) {
    yield* Effect.annotateCurrentSpan({
      threadId: options.id,
      workspaceId: options.workspaceId,
    });

    const rows = yield* execute(
      "ChatThreadRepo.archive",
      db
        .update(chatThread)
        .set({ isCurrent: false, status: "archived" })
        .where(refOf(options))
        .returning()
    );

    yield* firstRow({ entity: ENTITY, id: options.id, rows });

    return yield* decodeWritten({
      decode: decodeChatThread,
      entity: ENTITY,
      operation: "ChatThreadRepo.archive",
      rows,
    });
  });

  return {
    archive,
    awaitingReply,
    byId,
    current,
    listForChat,
    listForWorkspace,
    open,
    retitle,
    setCurrent,
  } as const;
});

/** The chat's conversations. Not audited: a conversation is not board state. */
export class ChatThreadRepo extends Context.Service<
  ChatThreadRepo,
  Effect.Success<typeof make>
>()("@workspace/db/ChatThreadRepo") {
  static readonly layer = Layer.effect(ChatThreadRepo, make);
}
