/**
 * What was said in a chat thread, and the manager agent's only memory.
 *
 * The manager is invoked once per message with no state of its own, so the
 * prompt for the next turn is the tail of this table read back in order. That
 * is why the words are stored and why the read is a tail rather than a search:
 * the thread's `(created_at, id)` index is exactly the order a conversation is
 * replayed in.
 *
 * Append-only, enforced by revoked privileges. Nothing edits what was said, and
 * a turn that failed writes no manager row at all — the user's question stays
 * unanswered in the history, which is the honest record and is also what the
 * next prompt should show.
 *
 * Appending also moves the thread to the top of its chat's list and titles an
 * untitled thread from its first message. Both are properties of the thread
 * that only a message can change, so they are written in the same transaction:
 * a list ordered by a timestamp that failed to move is a list that hides the
 * conversation someone is having.
 */

import type {
  ChatIntakeKind,
  ChatMessageRole,
  TelegramChatId,
  TelegramMessageId,
  ThreadId,
  WorkspaceId,
} from "@workspace/domain";
import { newChatMessageId } from "@workspace/domain";
import { and, asc, desc, eq, sql } from "drizzle-orm";
import { Context, Effect, Layer } from "effect";
import { Database } from "../client";
import { ChatMessageInsert, decodeChatMessage } from "../rows";
import { chatMessage, chatThread } from "../schema/chat";
import {
  decodeMany,
  decodeWritten,
  encodeWrite,
  execute,
  unauditedTransaction,
} from "./audit";
import { THREAD_TITLE_MAX_CHARS } from "./chat-thread";

/** How many messages the prompt builder reads back unless told otherwise. */
const DEFAULT_LIMIT = 40;

const ENTITY = "chat_message";

/** A thread's messages are never addressed without their workspace. */
export interface ThreadMessages {
  readonly threadId: ThreadId;
  readonly workspaceId: WorkspaceId;
}

/**
 * One message, in either direction. The optional fields are the ones that
 * describe how it travelled — a voice note's transcript length, a forward's
 * sender, the session a manager turn ran under — and each is absent rather than
 * zeroed when it does not apply.
 */
export interface ChatMessageAppend extends ThreadMessages {
  readonly body: string;
  readonly forwardFrom?: string | null;
  /** Set for a `user` message and refused on the manager's own. */
  readonly intakeKind?: ChatIntakeKind | null;
  readonly providerSessionId?: string | null;
  readonly role: ChatMessageRole;
  readonly telegramChatId: TelegramChatId;
  readonly telegramMessageId?: TelegramMessageId | null;
  readonly transcriptChars?: number | null;
}

const make = Effect.gen(function* () {
  const db = yield* Database;
  const inTransaction = unauditedTransaction(db);

  const threadOf = (ref: ThreadMessages) =>
    and(
      eq(chatMessage.workspaceId, ref.workspaceId),
      eq(chatMessage.threadId, ref.threadId)
    );

  /**
   * Records one message and moves its thread to the top of the list.
   *
   * The title is set with `coalesce` rather than read first and written back,
   * so the opening message wins the race against anything that arrives beside
   * it, and the statement is the same one whether or not a title is already
   * there.
   */
  const append = Effect.fn("ChatMessageRepo.append")(function* (
    input: ChatMessageAppend
  ) {
    yield* Effect.annotateCurrentSpan({
      threadId: input.threadId,
      workspaceId: input.workspaceId,
    });

    const values = yield* encodeWrite({
      entity: ENTITY,
      schema: ChatMessageInsert,
      value: {
        body: input.body,
        forwardFrom: input.forwardFrom ?? null,
        id: newChatMessageId(),
        intakeKind: input.intakeKind ?? null,
        providerSessionId: input.providerSessionId ?? null,
        role: input.role,
        telegramChatId: input.telegramChatId,
        telegramMessageId: input.telegramMessageId ?? null,
        threadId: input.threadId,
        transcriptChars: input.transcriptChars ?? null,
        workspaceId: input.workspaceId,
      },
    });

    return yield* inTransaction(
      { operation: "ChatMessageRepo.append", table: ENTITY },
      (tx) =>
        Effect.gen(function* () {
          const rows = yield* execute(
            "ChatMessageRepo.append",
            tx.insert(chatMessage).values(values).returning()
          );

          const posted = yield* decodeWritten({
            decode: decodeChatMessage,
            entity: ENTITY,
            operation: "ChatMessageRepo.append",
            rows,
          });

          yield* execute(
            "ChatMessageRepo.append",
            tx
              .update(chatThread)
              .set({
                lastMessageAt: sql`now()`,
                title: sql`coalesce(${chatThread.title}, left(${input.body}, ${THREAD_TITLE_MAX_CHARS}))`,
              })
              .where(
                and(
                  eq(chatThread.workspaceId, input.workspaceId),
                  eq(chatThread.id, input.threadId)
                )
              )
          );

          return posted;
        })
    );
  });

  /**
   * The tail of a thread, oldest first — the shape a prompt is built from. The
   * newest rows are selected and then reversed, because "the last forty" is a
   * descending read and "what the conversation said" is an ascending one, and
   * doing it in the query would make the planner sort the whole thread.
   */
  const recent = Effect.fn("ChatMessageRepo.recent")(function* (
    options: ThreadMessages & { readonly limit?: number }
  ) {
    yield* Effect.annotateCurrentSpan({
      threadId: options.threadId,
      workspaceId: options.workspaceId,
    });

    const rows = yield* execute(
      "ChatMessageRepo.recent",
      db
        .select()
        .from(chatMessage)
        .where(threadOf(options))
        .orderBy(desc(chatMessage.createdAt), desc(chatMessage.id))
        .limit(options.limit ?? DEFAULT_LIMIT)
    );

    const decoded = yield* decodeMany({
      decode: decodeChatMessage,
      entity: ENTITY,
      rows,
    });

    return [...decoded].reverse();
  });

  /** A page of a thread, oldest first — what `/history` walks through. */
  const listForThread = Effect.fn("ChatMessageRepo.listForThread")(function* (
    options: ThreadMessages & {
      readonly limit?: number;
      readonly offset?: number;
    }
  ) {
    yield* Effect.annotateCurrentSpan({
      threadId: options.threadId,
      workspaceId: options.workspaceId,
    });

    const rows = yield* execute(
      "ChatMessageRepo.listForThread",
      db
        .select()
        .from(chatMessage)
        .where(threadOf(options))
        .orderBy(asc(chatMessage.createdAt), asc(chatMessage.id))
        .limit(options.limit ?? DEFAULT_LIMIT)
        .offset(options.offset ?? 0)
    );

    return yield* decodeMany({
      decode: decodeChatMessage,
      entity: ENTITY,
      rows,
    });
  });

  return { append, listForThread, recent } as const;
});

/** A thread's messages. Append-only, and the manager's whole memory. */
export class ChatMessageRepo extends Context.Service<
  ChatMessageRepo,
  Effect.Success<typeof make>
>()("@workspace/db/ChatMessageRepo") {
  static readonly layer = Layer.effect(ChatMessageRepo, make);
}
