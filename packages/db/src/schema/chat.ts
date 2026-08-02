import type {
  ChatIntakeKind,
  ChatMessageId,
  ChatMessageRole,
  ChatNotificationId,
  NotifyKind,
  RunId,
  SessionProvider,
  TaskId,
  TelegramChatId,
  TelegramMessageId,
  ThreadId,
  ThreadStatus,
  UserId,
} from "@workspace/domain";
import { sql } from "drizzle-orm";
import {
  bigint,
  boolean,
  check,
  foreignKey,
  index,
  integer,
  pgTable,
  text,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import { baseColumns, mutableColumns, tstz } from "./columns";
import { run } from "./run";

/**
 * The conversation. A thread is the identity of one conversation with the
 * manager agent, and the audit log names it: every board write a chat causes
 * lands with this id in `audit_entry.actor_thread_id`. That is why a thread is
 * archived rather than deleted — dropping it would orphan every audit row
 * already written.
 *
 * A thread is not a board card and not a Telegram chat. `chat_id` is null on
 * one opened from the dashboard, and the same thread is reachable from both
 * interfaces; a null chat id already says where it came from, so there is no
 * `origin` column to disagree with it.
 *
 * The provider's session id is not here. A turn is a run, a run has an
 * `agent_session`, and that row holds the id the provider handed back — one
 * fact in one column instead of three.
 *
 * The chat's current thread is a partial unique index rather than a rule a
 * switch handler follows, so two updates racing cannot leave a chat with two
 * current threads or with none it can find.
 */
export const chatThread = pgTable(
  "chat_thread",
  {
    ...mutableColumns<ThreadId>(),
    // Number mode, not bigint: a chat id is signed and wider than 32 bits, and
    // still far inside what a double holds exactly.
    chatId: bigint("chat_id", { mode: "number" }).$type<TelegramChatId>(),
    isCurrent: boolean("is_current").notNull().default(true),
    lastMessageAt: tstz("last_message_at").notNull().defaultNow(),
    provider: text("provider")
      .$type<SessionProvider>()
      .notNull()
      .default("claude"),
    status: text("status").$type<ThreadStatus>().notNull().default("active"),
    title: text("title"),
    userId: text("user_id").$type<UserId>().notNull(),
  },
  (t) => [
    uniqueIndex("chat_thread_workspace_id_id_uidx").on(t.workspaceId, t.id),
    // One current thread per chat, enforced rather than assumed. Currency is a
    // property of a chat, so a thread with no chat is outside the rule rather
    // than competing for it.
    uniqueIndex("chat_thread_current_uidx")
      .on(t.workspaceId, t.chatId)
      .where(sql`${t.isCurrent} and ${t.chatId} is not null`),
    index("chat_thread_workspace_id_chat_id_last_message_at_idx").on(
      t.workspaceId,
      t.chatId,
      t.lastMessageAt.desc()
    ),
    // Archiving is what `/new` does to the thread it replaces, so the archived
    // one can never still be the current one.
    check(
      "chat_thread_archived_not_current_ck",
      sql`not (${t.status} = 'archived' and ${t.isCurrent})`
    ),
  ]
);

/**
 * What was said, in both directions. Append-only, enforced by revoked
 * privileges rather than by the absence of an `updated_at` column.
 *
 * The text is stored because the manager has no memory of its own: it is
 * invoked once per turn, and the turn's prompt is what this table holds past
 * the session's watermark. Telemetry counts these characters and never carries
 * them; the split between the two is what keeps a chat's words in
 * workspace-scoped Postgres and out of a flat file an operator greps.
 *
 * An inserted `user` row is also the dispatch signal: the trigger on this table
 * is what tells the loop a thread has something to answer, the same way a task
 * moving into the in-progress column tells it a task does.
 */
export const chatMessage = pgTable(
  "chat_message",
  {
    ...baseColumns<ChatMessageId>(),
    body: text("body").notNull(),
    forwardFrom: text("forward_from"),
    intakeKind: text("intake_kind").$type<ChatIntakeKind>(),
    role: text("role").$type<ChatMessageRole>().notNull(),
    // The turn that answered, or that this question started. Set null rather
    // than cascaded away with the run, because what was said outlives it.
    runId: uuid("run_id")
      .$type<RunId>()
      .references(() => run.id, { onDelete: "set null" }),
    // Null on a message that never travelled through Telegram.
    telegramChatId: bigint("telegram_chat_id", {
      mode: "number",
    }).$type<TelegramChatId>(),
    telegramMessageId: bigint("telegram_message_id", {
      mode: "number",
    }).$type<TelegramMessageId>(),
    threadId: uuid("thread_id").$type<ThreadId>().notNull(),
    transcriptChars: integer("transcript_chars"),
  },
  (t) => [
    foreignKey({
      columns: [t.workspaceId, t.threadId],
      foreignColumns: [chatThread.workspaceId, chatThread.id],
      name: "chat_message_thread_fk",
    }).onDelete("cascade"),
    // How it arrived is a fact about an inbound message and meaningless about
    // the manager's own, so the two agree or the row is refused.
    check(
      "chat_message_intake_ck",
      sql`(${t.role} = 'user') = (${t.intakeKind} is not null)`
    ),
    // The prompt builder reads the tail in exactly this order.
    index("chat_message_thread_id_created_at_id_idx").on(
      t.threadId,
      t.createdAt,
      t.id
    ),
  ]
);

/**
 * The send ledger: one row per notice the bot volunteered, written before the
 * message is sent rather than after.
 *
 * Sending is claim, send, stamp. The unique key on `(workspace_id, dedupe_key)`
 * is the whole duplicate-suppression mechanism — a second process losing that
 * race learns somebody already has the notice — and a row still unstamped past
 * the grace period is a send that died between the claim and the message, which
 * the repair pass retries. At-least-once on purpose.
 *
 * No foreign key to `task` or `run`: the ledger outlives what it announced.
 */
export const chatNotification = pgTable(
  "chat_notification",
  {
    ...mutableColumns<ChatNotificationId>(),
    dedupeKey: text("dedupe_key").notNull(),
    kind: text("kind").$type<NotifyKind>().notNull(),
    runId: uuid("run_id").$type<RunId>(),
    // Null while claimed but not delivered.
    sentAt: tstz("sent_at"),
    taskId: uuid("task_id").$type<TaskId>().notNull(),
    telegramChatId: bigint("telegram_chat_id", { mode: "number" })
      .$type<TelegramChatId>()
      .notNull(),
    telegramMessageId: bigint("telegram_message_id", {
      mode: "number",
    }).$type<TelegramMessageId>(),
    threadId: uuid("thread_id").$type<ThreadId>(),
  },
  (t) => [
    uniqueIndex("chat_notification_workspace_id_dedupe_key_uidx").on(
      t.workspaceId,
      t.dedupeKey
    ),
    // The restart repair pass, which reads only what never went out.
    index("chat_notification_unsent_idx")
      .on(t.workspaceId, t.createdAt)
      .where(sql`${t.sentAt} is null`),
  ]
);
