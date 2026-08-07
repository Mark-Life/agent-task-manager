/**
 * The send ledger for everything the bot volunteers.
 *
 * A notice is claimed before it is sent and stamped after, so a process that
 * dies between the two leaves a row saying what it was about to do. The unique
 * key on `(workspace_id, dedupe_key)` is the whole duplicate-suppression
 * mechanism: a second attempt at the same notice loses the insert and learns
 * that somebody already has it, which is what stops a restart from re-announcing
 * every run that finished while it was down.
 *
 * At-least-once, deliberately. {@link ChatNotificationRepo} exposes the unsent
 * claims older than a grace period precisely so they can be tried again — a
 * duplicate "your run failed" is a nuisance, and a missing one is a lie.
 *
 * Not audited, and no foreign key to the task or the run: this is a record of
 * what the bot said, and it has to outlive what it said it about.
 */

import type {
  ChatNotificationId,
  NotifyKind,
  RunId,
  TaskId,
  TelegramChatId,
  TelegramMessageId,
  ThreadId,
  Timestamp,
  WorkspaceId,
} from "@workspace/domain";
import { newChatNotificationId } from "@workspace/domain";
import { and, asc, desc, eq, isNull, lt } from "drizzle-orm";
import { Context, DateTime, Effect, Layer } from "effect";
import { Database } from "../client";
import {
  ChatNotificationInsert,
  ChatNotificationUpdate,
  decodeChatNotification,
} from "../rows";
import { chatNotification } from "../schema/chat";
import {
  decodeMany,
  decodeWritten,
  encodeWrite,
  execute,
  firstRow,
} from "./audit";

/** How many stale claims one repair pass reads. Bounded, because a pass has to end. */
const DEFAULT_LIMIT = 50;

/** Reads that want the newest row and nothing else say so to the planner. */
const ONE = 1;

const ENTITY = "chat_notification";

/** A claim is never addressed by id alone: every query names its workspace. */
export interface NotificationRef {
  readonly id: ChatNotificationId;
  readonly workspaceId: WorkspaceId;
}

/**
 * What claiming a notice needs. `dedupeKey` is whatever the emitter can repeat
 * exactly for the same event — a run that finished twice in one process's mind
 * is one key — and `threadId` is null when no conversation could be resolved,
 * which is a visible miss rather than a dropped notice.
 */
export interface ChatNotificationClaim {
  readonly dedupeKey: string;
  readonly kind: NotifyKind;
  readonly runId?: RunId | null;
  /** Null on a notice about the system itself; the table's CHECK enforces the pairing. */
  readonly taskId: TaskId | null;
  readonly telegramChatId: TelegramChatId;
  readonly threadId?: ThreadId | null;
  readonly workspaceId: WorkspaceId;
}

const make = Effect.gen(function* () {
  const db = yield* Database;

  const refOf = (ref: NotificationRef) =>
    and(
      eq(chatNotification.workspaceId, ref.workspaceId),
      eq(chatNotification.id, ref.id)
    );

  /**
   * Takes the right to send one notice, or answers null because somebody
   * already has it. The conflict is the mechanism, not an error: two processes
   * reacting to the same run event is the expected case, and exactly one of
   * them comes back holding a row.
   */
  const claim = Effect.fn("ChatNotificationRepo.claim")(function* (
    input: ChatNotificationClaim
  ) {
    yield* Effect.annotateCurrentSpan({
      taskId: input.taskId,
      workspaceId: input.workspaceId,
    });

    const values = yield* encodeWrite({
      entity: ENTITY,
      schema: ChatNotificationInsert,
      value: {
        dedupeKey: input.dedupeKey,
        id: newChatNotificationId(),
        kind: input.kind,
        runId: input.runId ?? null,
        // A claim is unsent by definition: both stamps land only once the
        // message is really in the chat.
        sentAt: null,
        taskId: input.taskId ?? null,
        telegramChatId: input.telegramChatId,
        telegramMessageId: null,
        threadId: input.threadId ?? null,
        workspaceId: input.workspaceId,
      },
    });

    const rows = yield* execute(
      "ChatNotificationRepo.claim",
      db
        .insert(chatNotification)
        .values(values)
        .onConflictDoNothing({
          target: [chatNotification.workspaceId, chatNotification.dedupeKey],
        })
        .returning()
    );

    const [row] = rows;
    if (row === undefined) {
      return null;
    }

    return yield* decodeWritten({
      decode: decodeChatNotification,
      entity: ENTITY,
      operation: "ChatNotificationRepo.claim",
      rows,
    });
  });

  /**
   * Records that the message went out, and which message it was. Until this
   * lands the claim reads as unsent, which is what makes a crash between the
   * claim and the send recoverable rather than silent.
   */
  const markSent = Effect.fn("ChatNotificationRepo.markSent")(function* (
    options: NotificationRef & {
      readonly telegramMessageId: TelegramMessageId | null;
    }
  ) {
    yield* Effect.annotateCurrentSpan({ workspaceId: options.workspaceId });

    const sentAt = yield* DateTime.now;

    const values = yield* encodeWrite({
      entity: ENTITY,
      schema: ChatNotificationUpdate,
      value: { sentAt, telegramMessageId: options.telegramMessageId },
    });

    const rows = yield* execute(
      "ChatNotificationRepo.markSent",
      db.update(chatNotification).set(values).where(refOf(options)).returning()
    );

    yield* firstRow({ entity: ENTITY, id: options.id, rows });

    return yield* decodeWritten({
      decode: decodeChatNotification,
      entity: ENTITY,
      operation: "ChatNotificationRepo.markSent",
      rows,
    });
  });

  /**
   * Claims that were never stamped and are old enough that the process holding
   * them is not coming back. Oldest first, so a backlog drains in the order it
   * happened, and bounded, because the repair pass runs on a tick.
   */
  const unsentBefore = Effect.fn("ChatNotificationRepo.unsentBefore")(
    function* (options: {
      readonly claimedBefore: Timestamp;
      readonly limit?: number;
      readonly workspaceId: WorkspaceId;
    }) {
      yield* Effect.annotateCurrentSpan({ workspaceId: options.workspaceId });

      const rows = yield* execute(
        "ChatNotificationRepo.unsentBefore",
        db
          .select()
          .from(chatNotification)
          .where(
            and(
              eq(chatNotification.workspaceId, options.workspaceId),
              isNull(chatNotification.sentAt),
              lt(
                chatNotification.createdAt,
                DateTime.toDate(options.claimedBefore)
              )
            )
          )
          .orderBy(asc(chatNotification.createdAt), asc(chatNotification.id))
          .limit(options.limit ?? DEFAULT_LIMIT)
      );

      return yield* decodeMany({
        decode: decodeChatNotification,
        entity: ENTITY,
        rows,
      });
    }
  );

  /**
   * The newest notice of one kind in a workspace, claimed or delivered, or null
   * when there has never been one.
   *
   * Claimed counts, deliberately: this is what the restart announcement asks
   * before it says anything, and "somebody already took this a minute ago" is
   * the answer that keeps a crash loop out of the chat whether or not the
   * message it took made it to Telegram.
   */
  const newestOfKind = Effect.fn("ChatNotificationRepo.newestOfKind")(
    function* (options: {
      readonly kind: NotifyKind;
      readonly workspaceId: WorkspaceId;
    }) {
      yield* Effect.annotateCurrentSpan({ workspaceId: options.workspaceId });

      const rows = yield* execute(
        "ChatNotificationRepo.newestOfKind",
        db
          .select()
          .from(chatNotification)
          .where(
            and(
              eq(chatNotification.workspaceId, options.workspaceId),
              eq(chatNotification.kind, options.kind)
            )
          )
          .orderBy(desc(chatNotification.createdAt), desc(chatNotification.id))
          .limit(ONE)
      );

      const [row] = rows;
      if (row === undefined) {
        return null;
      }

      return yield* decodeWritten({
        decode: decodeChatNotification,
        entity: ENTITY,
        operation: "ChatNotificationRepo.newestOfKind",
        rows,
      });
    }
  );

  return { claim, markSent, newestOfKind, unsentBefore } as const;
});

/** What the bot has volunteered, and what it is about to. Not audited. */
export class ChatNotificationRepo extends Context.Service<
  ChatNotificationRepo,
  Effect.Success<typeof make>
>()("@workspace/db/ChatNotificationRepo") {
  static readonly layer = Layer.effect(ChatNotificationRepo, make);
}
