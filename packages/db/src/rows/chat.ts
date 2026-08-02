import {
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
  Timestamp,
  UserId,
  WorkspaceId,
} from "@workspace/domain";
import {
  createInsertSchema,
  createSelectSchema,
  createUpdateSchema,
} from "drizzle-orm/effect-schema";
import { Schema } from "effect";
import { chatMessage, chatNotification, chatThread } from "../schema/chat";

const threadColumns = {
  chatId: () => TelegramChatId,
  id: () => ThreadId,
  provider: () => SessionProvider,
  status: () => ThreadStatus,
  userId: () => UserId,
  workspaceId: () => WorkspaceId,
};

/** A `chat_thread` row as the database hands it back. */
export const ChatThreadRow = createSelectSchema(chatThread, {
  ...threadColumns,
  createdAt: () => Timestamp,
  lastMessageAt: () => Timestamp,
  updatedAt: () => Timestamp,
});

/**
 * What a repository writes to open a thread. `last_message_at` is left off, like
 * `created_at`: the column default owns the clock, so a writer cannot introduce
 * a skew between the row's two timestamps.
 */
export const ChatThreadInsert = createInsertSchema(chatThread, threadColumns);

/** What a repository writes to switch, clear, retitle or archive a thread. */
export const ChatThreadUpdate = createUpdateSchema(chatThread, {
  ...threadColumns,
  lastMessageAt: () => Timestamp,
});

/** Turns a raw row into the domain entity. */
export const decodeChatThread = Schema.decodeUnknownEffect(ChatThreadRow);

const messageColumns = {
  id: () => ChatMessageId,
  intakeKind: () => ChatIntakeKind,
  role: () => ChatMessageRole,
  telegramChatId: () => TelegramChatId,
  telegramMessageId: () => TelegramMessageId,
  threadId: () => ThreadId,
  transcriptChars: () => Schema.Natural,
  workspaceId: () => WorkspaceId,
};

/** A `chat_message` row as the database hands it back. */
export const ChatMessageRow = createSelectSchema(chatMessage, {
  ...messageColumns,
  createdAt: () => Timestamp,
});

/** What a repository writes to record what was said. */
export const ChatMessageInsert = createInsertSchema(
  chatMessage,
  messageColumns
);

/** Turns a raw row into the domain entity. */
export const decodeChatMessage = Schema.decodeUnknownEffect(ChatMessageRow);

const notificationColumns = {
  id: () => ChatNotificationId,
  kind: () => NotifyKind,
  runId: () => RunId,
  taskId: () => TaskId,
  telegramChatId: () => TelegramChatId,
  telegramMessageId: () => TelegramMessageId,
  threadId: () => ThreadId,
  workspaceId: () => WorkspaceId,
};

/** A `chat_notification` row as the database hands it back. */
export const ChatNotificationRow = createSelectSchema(chatNotification, {
  ...notificationColumns,
  createdAt: () => Timestamp,
  sentAt: () => Timestamp,
  updatedAt: () => Timestamp,
});

/** What a repository writes to claim a notice. */
export const ChatNotificationInsert = createInsertSchema(chatNotification, {
  ...notificationColumns,
  sentAt: () => Timestamp,
});

/** What a repository writes to stamp a claim as delivered. */
export const ChatNotificationUpdate = createUpdateSchema(chatNotification, {
  ...notificationColumns,
  sentAt: () => Timestamp,
});

/** Turns a raw row into the domain entity. */
export const decodeChatNotification =
  Schema.decodeUnknownEffect(ChatNotificationRow);
