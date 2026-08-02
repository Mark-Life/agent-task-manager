/**
 * Conversations with the manager agent, one per Telegram chat at a time.
 *
 * A thread is the conversation's identity and the audit log points at it, so
 * nothing here deletes one. Opening a new conversation drops the currency of
 * the old thread and keeps its rows; clearing one nulls the provider's session
 * id, which is the only part of a conversation that is safe to forget — the
 * words are in `chat_message`, so a cleared thread costs the provider its
 * transcript and costs us nothing.
 *
 * No audit rows and no actor. A chat is not board state: every board write a
 * conversation causes goes over the gateway, where the manager's actor already
 * carries this thread's id, so the conversation is named on the row it caused
 * rather than on a row of its own.
 */

import type {
  ChatThread,
  SessionProvider,
  TelegramChatId,
  ThreadId,
  UserId,
  WorkspaceId,
} from "@workspace/domain";
import { newThreadId } from "@workspace/domain";
import { and, desc, eq, ne } from "drizzle-orm";
import { Context, Effect, Layer } from "effect";
import { Database } from "../client";
import { ChatThreadInsert, ChatThreadUpdate, decodeChatThread } from "../rows";
import { chatThread } from "../schema/chat";
import {
  decodeMany,
  decodeWritten,
  encodeWrite,
  execute,
  firstRow,
  unauditedTransaction,
} from "./audit";

/** Reads addressed by id match one row; the limit says so to the planner. */
const ONE = 1;

/** How many threads a chat's list returns unless told otherwise. */
const DEFAULT_LIMIT = 20;

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
export interface ChatThreadOpen extends ChatRef {
  readonly provider: SessionProvider;
  readonly title?: string | null;
  readonly userId: UserId;
}

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
        chatId: input.chatId,
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
          yield* execute(
            "ChatThreadRepo.open",
            tx
              .update(chatThread)
              .set({ isCurrent: false })
              .where(and(chatOf(input), eq(chatThread.isCurrent, true)))
          );

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
   * Makes one thread the current one for its chat. The chat is read off the
   * thread rather than taken from the caller, so a switch cannot move currency
   * between two chats, and the row is locked for the length of the swap.
   */
  const setCurrent = Effect.fn("ChatThreadRepo.setCurrent")(function* (
    options: ChatThreadRef
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

          yield* execute(
            "ChatThreadRepo.setCurrent",
            tx
              .update(chatThread)
              .set({ isCurrent: false })
              .where(
                and(
                  chatOf({
                    chatId: target.chatId,
                    workspaceId: options.workspaceId,
                  }),
                  eq(chatThread.isCurrent, true),
                  ne(chatThread.id, options.id)
                )
              )
          );

          const rows = yield* execute(
            "ChatThreadRepo.setCurrent",
            tx
              .update(chatThread)
              .set({ isCurrent: true, status: "active" })
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

  const patch = (
    operation: string,
    ref: ChatThreadRef,
    fields: Partial<Pick<ChatThread, "providerSessionId" | "status" | "title">>
  ) =>
    Effect.gen(function* () {
      const values = yield* encodeWrite({
        entity: ENTITY,
        schema: ChatThreadUpdate,
        value: fields,
      });

      const rows = yield* execute(
        operation,
        db.update(chatThread).set(values).where(refOf(ref)).returning()
      );

      yield* firstRow({ entity: ENTITY, id: ref.id, rows });

      return yield* decodeWritten({
        decode: decodeChatThread,
        entity: ENTITY,
        operation,
        rows,
      });
    });

  /**
   * Records the session the provider handed back, so the next turn resumes
   * instead of starting over. Written after every turn that produced one,
   * including a crashed turn — a run that got as far as a session is still
   * resumable.
   */
  const setProviderSession = Effect.fn("ChatThreadRepo.setProviderSession")(
    function* (
      options: ChatThreadRef & { readonly providerSessionId: string | null }
    ) {
      yield* Effect.annotateCurrentSpan({
        threadId: options.id,
        workspaceId: options.workspaceId,
      });

      return yield* patch("ChatThreadRepo.setProviderSession", options, {
        providerSessionId: options.providerSessionId,
      });
    }
  );

  /**
   * Forgets the provider's transcript and keeps the conversation. This is what
   * `/clear` does: the thread, its history and everything the audit log says
   * about it survive, and only the provider starts the next turn cold.
   */
  const clearProviderSession = Effect.fn("ChatThreadRepo.clearProviderSession")(
    function* (options: ChatThreadRef) {
      yield* Effect.annotateCurrentSpan({
        threadId: options.id,
        workspaceId: options.workspaceId,
      });

      return yield* patch("ChatThreadRepo.clearProviderSession", options, {
        providerSessionId: null,
      });
    }
  );

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
    byId,
    clearProviderSession,
    current,
    listForChat,
    open,
    setCurrent,
    setProviderSession,
  } as const;
});

/** The chat's conversations. Not audited: a conversation is not board state. */
export class ChatThreadRepo extends Context.Service<
  ChatThreadRepo,
  Effect.Success<typeof make>
>()("@workspace/db/ChatThreadRepo") {
  static readonly layer = Layer.effect(ChatThreadRepo, make);
}
