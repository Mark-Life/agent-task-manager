/**
 * The small, pure things every Telegram handler needs, kept together so none of
 * them is spelled twice.
 *
 * Two of them carry a rule worth stating out loud.
 *
 * `escapeHtml` is the only sanctioned way text a person or a model wrote
 * reaches a message sent with `parse_mode: "HTML"`. Telegram's HTML subset
 * treats an unescaped `<` as the start of a tag, so an unescaped message is at
 * best a send that fails with `can't parse entities` and at worst a message
 * that renders as somebody else's markup.
 *
 * `swallow` marks the calls whose failure genuinely does not matter — a pin
 * that did not take, a status message that was already deleted. Everything
 * else gets a typed error. A `catch(swallow)` on a send that carries content is
 * how a message disappears without a trace.
 */

import { DateTime } from "effect";
import type { Context } from "grammy";

/** How much of a replied-to message is quoted back into a prompt. */
const REPLY_CONTEXT_MAX_CHARS = 2000;

/** Minutes in an hour, hours in a day, days in a week — for the relative clock. */
const MINUTES_PER_HOUR = 60;
const HOURS_PER_DAY = 24;
const DAYS_PER_WEEK = 7;
const MS_PER_MINUTE = 60_000;
const MS_PER_SECOND = 1000;

/**
 * Escape the three characters Telegram's HTML parse mode treats as markup.
 *
 * Deliberately not a general HTML escaper: Telegram's subset has no attributes
 * to break out of, so quotes are left alone and the output stays readable.
 */
export const escapeHtml = (text: string) =>
  text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

/**
 * The rejection handler for a Telegram call whose failure changes nothing —
 * an unpin, a status edit, a typing action. Named rather than inlined so a
 * reviewer can grep for every place a failure is being dropped on purpose.
 */
export const swallow = () => {
  // Best-effort chrome: a failure here has no consequence worth reporting.
};

/** The chat an update happened in, or null for the updates that have none. */
export const chatIdOf = (ctx: Context) => ctx.chat?.id ?? null;

/**
 * The chat id, for handlers that cannot proceed without one.
 *
 * Message and callback-query updates always carry a chat; the ones that do not
 * (inline queries, poll answers) are not registered anywhere in this app, so
 * reaching the throw means a handler was wired to an update kind it was never
 * written for.
 */
export const requireChat = (ctx: Context) => {
  const chatId = chatIdOf(ctx);
  if (chatId === null) {
    throw new Error("update carries no chat");
  }
  return chatId;
};

/** Where a forwarded message came from, as Telegram describes it. */
export type ForwardOrigin = NonNullable<
  NonNullable<Context["message"]>["forward_origin"]
>;

/**
 * A display name for the origin of a forward.
 *
 * Free text from a stranger: it is quoted into a prompt and stored on
 * `chat_message.forward_from`, so every caller escapes it before it reaches a
 * message.
 */
export const forwardSenderName = (origin: ForwardOrigin) => {
  if (origin.type === "user") {
    return origin.sender_user.first_name;
  }
  if (origin.type === "channel") {
    return origin.chat.title;
  }
  if (origin.type === "hidden_user") {
    return origin.sender_user_name;
  }
  return "unknown";
};

/**
 * Replace the chat's pinned message with the given one, best-effort.
 *
 * Unpin-then-pin rather than pin-and-hope: Telegram keeps a stack of pins, and
 * a bot that only ever pins leaves a chat with a pin list nobody asked for.
 */
export const repinMessage = async (options: {
  readonly chatId: number;
  readonly ctx: Context;
  readonly message: Awaited<ReturnType<Context["editMessageText"]>>;
}) => {
  const { chatId, ctx, message } = options;
  await ctx.api.unpinAllChatMessages(chatId).catch(swallow);
  const pinnedId =
    typeof message === "object" && "message_id" in message
      ? message.message_id
      : null;
  if (pinnedId !== null) {
    await ctx.api
      .pinChatMessage(chatId, pinnedId, { disable_notification: true })
      .catch(swallow);
  }
};

/**
 * Prepend the message being replied to, so "do that for the other one too"
 * reaches the manager with an antecedent.
 *
 * The bot's own messages are skipped: quoting the previous answer back into the
 * next prompt doubles the transcript the thread's history already carries.
 */
export const buildPromptWithReplyContext = (options: {
  readonly botId: number | null;
  readonly ctx: Context;
  readonly text: string;
}) => {
  const { botId, ctx, text } = options;
  const replied = ctx.message?.reply_to_message;
  const replyText = replied?.text;
  if (!replyText) {
    return text;
  }
  if (botId !== null && replied?.from?.id === botId) {
    return text;
  }
  const quoted =
    replyText.length > REPLY_CONTEXT_MAX_CHARS
      ? `${replyText.slice(0, REPLY_CONTEXT_MAX_CHARS)}...`
      : replyText;
  return `[Replying to: ${quoted}]\n\n${text}`;
};

/**
 * A compact "how long ago" for a list of threads or messages.
 *
 * `now` is a parameter rather than a read of the wall clock so the function is
 * a pure one a test can pin. Past a week it degrades to a date, because "9d
 * ago" is arithmetic the reader has to do and "Mar 3" is not.
 */
export const formatRelativeTime = (options: {
  readonly at: DateTime.Utc;
  readonly now: DateTime.Utc;
}) => {
  const { at, now } = options;
  const diffMin = Math.floor(
    (DateTime.toEpochMillis(now) - DateTime.toEpochMillis(at)) / MS_PER_MINUTE
  );
  if (diffMin < 1) {
    return "just now";
  }
  if (diffMin < MINUTES_PER_HOUR) {
    return `${diffMin}m ago`;
  }
  const diffHour = Math.floor(diffMin / MINUTES_PER_HOUR);
  if (diffHour < HOURS_PER_DAY) {
    return `${diffHour}h ago`;
  }
  const diffDay = Math.floor(diffHour / HOURS_PER_DAY);
  if (diffDay < DAYS_PER_WEEK) {
    return `${diffDay}d ago`;
  }
  return DateTime.toDateUtc(at).toLocaleDateString("en-US", {
    day: "numeric",
    month: "short",
    timeZone: "UTC",
  });
};

/**
 * A duration a person reads at a glance: seconds under a minute, then minutes.
 * Null in, null out — a run that reported no duration is not a zero-second run.
 */
export const formatDuration = (durationMs: number | null) => {
  if (durationMs === null) {
    return null;
  }
  const seconds = durationMs / MS_PER_SECOND;
  if (seconds < MINUTES_PER_HOUR) {
    return `${seconds.toFixed(1)}s`;
  }
  const minutes = Math.floor(seconds / MINUTES_PER_HOUR);
  const rest = Math.round(seconds - minutes * MINUTES_PER_HOUR);
  return `${minutes}m ${rest}s`;
};
