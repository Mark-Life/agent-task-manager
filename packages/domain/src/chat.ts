import { Schema } from "effect";
import {
  ChatIntakeKind,
  ChatMessageRole,
  NotifyKind,
  SessionProvider,
  ThreadStatus,
} from "./enums";
import {
  ChatMessageId,
  ChatNotificationId,
  RunId,
  TaskId,
  ThreadId,
  UserId,
} from "./ids";
import { appendOnlyFields, recordFields, Timestamp } from "./primitives";

/**
 * A Telegram chat. Signed, because a group chat's id is negative, and wider
 * than 32 bits, which is why the column behind it is a `bigint` read as a
 * number — Telegram's ids stay well inside what a double represents exactly.
 */
export const TelegramChatId = Schema.Int.pipe(Schema.brand("TelegramChatId"));
export type TelegramChatId = typeof TelegramChatId.Type;

/** One message as Telegram numbered it, inside its chat. */
export const TelegramMessageId = Schema.Int.pipe(
  Schema.brand("TelegramMessageId")
);
export type TelegramMessageId = typeof TelegramMessageId.Type;

/**
 * One conversation with the manager agent, in one Telegram chat.
 *
 * The thread is the conversation's identity, and the audit log points at it:
 * every board write a chat causes lands with this id in `actor_thread_id`,
 * which is what later answers "which conversation asked for this". So a thread
 * is archived, never deleted, and clearing a conversation nulls
 * {@link ChatThread.providerSessionId} rather than dropping the row.
 *
 * `providerSessionId` is a column of its own instead of a field inside the
 * provider's name because the two have different lifetimes: the provider is
 * chosen, the session is handed back by it, and switching providers has to
 * forget the second without forgetting the first. Losing it costs a longer
 * prompt, not the conversation — the history is in `chat_message`.
 */
export const ChatThread = Schema.Struct({
  ...recordFields,
  chatId: TelegramChatId,
  id: ThreadId,
  /** The chat's current thread. At most one per chat, enforced by a partial unique index. */
  isCurrent: Schema.Boolean,
  /** Ordering key for the thread list, so a long-quiet thread sinks. */
  lastMessageAt: Timestamp,
  provider: SessionProvider,
  /** Null until the provider names one, and again whenever the conversation is cleared. */
  providerSessionId: Schema.NullOr(Schema.String),
  status: ThreadStatus,
  /** The opening message, clipped — what the thread list shows instead of a uuid. */
  title: Schema.NullOr(Schema.String),
  /** Who the thread speaks for. No foreign key: attribution outlives accounts. */
  userId: UserId,
});

export interface ChatThread extends Schema.Schema.Type<typeof ChatThread> {}

/**
 * One message in a thread, in either direction. Append-only: nothing edits what
 * was said.
 *
 * The words are stored, deliberately. The manager is invoked once per message
 * with no memory of its own, so this table *is* its memory — the prompt for the
 * next turn is built by reading the tail of it. That is a different thing from
 * telemetry, which counts characters and never carries them, and the two are
 * kept apart by their storage rather than by a convention: this is
 * workspace-scoped Postgres, and the event ledger is a flat file.
 */
export const ChatMessage = Schema.Struct({
  ...appendOnlyFields,
  body: Schema.String,
  /** The sanitized sender of a forwarded message. Null otherwise. */
  forwardFrom: Schema.NullOr(Schema.String),
  id: ChatMessageId,
  /** How the message arrived. Set for `user` messages and null for the manager's own. */
  intakeKind: Schema.NullOr(ChatIntakeKind),
  /** The session the turn actually ran under, on the manager's side only. */
  providerSessionId: Schema.NullOr(Schema.String),
  role: ChatMessageRole,
  telegramChatId: TelegramChatId,
  /** The inbound update's id, or the id of what the bot sent. Null when the send failed. */
  telegramMessageId: Schema.NullOr(TelegramMessageId),
  threadId: ThreadId,
  /** Length of what a voice note transcribed to. Non-null only for `voice`. */
  transcriptChars: Schema.NullOr(Schema.Natural),
});

export interface ChatMessage extends Schema.Schema.Type<typeof ChatMessage> {}

/**
 * One notice the bot volunteered, and the claim that let it. Sending is
 * claim-then-send-then-stamp: the unique key on `(workspaceId, dedupeKey)` is
 * the whole duplicate-suppression mechanism, and a row still unstamped after
 * the grace period is a send that died between the two and gets retried.
 * At-least-once on purpose — a repeated "your run failed" is a nuisance, a
 * missing one is a lie.
 *
 * No foreign key to the task or the run it announces: the ledger has to outlive
 * what it was about.
 */
export const ChatNotification = Schema.Struct({
  ...recordFields,
  /** `${kind}:${taskId}:${runId ?? "-"}`, or whatever the emitter can repeat exactly. */
  dedupeKey: Schema.String,
  id: ChatNotificationId,
  kind: NotifyKind,
  runId: Schema.NullOr(RunId),
  /** Null while the notice is claimed but not delivered. */
  sentAt: Schema.NullOr(Timestamp),
  taskId: TaskId,
  telegramChatId: TelegramChatId,
  telegramMessageId: Schema.NullOr(TelegramMessageId),
  /** Null when no conversation could be resolved, so the miss stays visible. */
  threadId: Schema.NullOr(ThreadId),
});

export interface ChatNotification
  extends Schema.Schema.Type<typeof ChatNotification> {}
