/**
 * A chat's conversations, and the four things a person can do to them.
 *
 * A thread is the identity of one conversation with the manager: the prompt is
 * built from its messages, the provider's session is remembered against it, and
 * every board write a chat causes carries its id into `actor_thread_id`. So the
 * lifecycle here is deliberately narrow — open, switch, clear, list — and there
 * is no delete. A conversation is retired by being spoken to no longer.
 *
 * The rules that could be spelled differently in two handlers are spelled once
 * here instead. **A chat always has exactly one current thread**: the first
 * message opens one rather than failing, which is why {@link ensureThread}
 * exists and why no handler below ever sees a null thread. **Opening is what
 * `/new` means** — the previous thread keeps its history and its `active`
 * status and merely stops being current, so `/switch` brings it back whole.
 * **Clearing is not closing**: `/clear` forgets the provider's transcript and
 * keeps the row, because the audit trail already points at it.
 *
 * Nothing here touches grammy. A handler decides what to say; this module
 * decides what is true.
 */

import {
  type ChatRef,
  type ChatThreadRef,
  ChatThreadRepo,
  THREAD_TITLE_MAX_CHARS,
} from "@workspace/db";
import {
  type ChatThread,
  type SessionProvider,
  TelegramChatId,
  type UserId,
} from "@workspace/domain";
import { DateTime, Effect } from "effect";
import { formatRelativeTime } from "./helpers";

/** What a thread label falls back to when nothing has been said in it yet. */
const UNTITLED_THREAD = "(untitled)";

/** How much of a title fits on an inline button beside its age. */
const BUTTON_TITLE_MAX_CHARS = 32;

/** Everything opening a conversation for a chat needs, minus the title. */
export interface ThreadContext extends ChatRef {
  readonly provider: SessionProvider;
  readonly userId: UserId;
}

/**
 * The chat's current conversation, opening one when the chat has never had a
 * conversation at all.
 *
 * The open is not conditional on a check this process made a moment ago in any
 * meaningful sense: the partial unique index allows one current thread per
 * chat, so two updates racing here end with one of them failing loudly rather
 * than with two current threads, which is the outcome worth having.
 */
export const ensureThread = Effect.fn("bot.threads.ensure")(function* (
  context: ThreadContext
) {
  const repo = yield* ChatThreadRepo;
  const current = yield* repo.current({
    chatId: context.chatId,
    workspaceId: context.workspaceId,
  });
  return current ?? (yield* repo.open(context));
});

/**
 * Open a fresh conversation and make it the chat's current one — what `/new`
 * does. The thread it displaces keeps everything except its currency.
 */
export const startThread = Effect.fn("bot.threads.start")(function* (
  context: ThreadContext
) {
  const repo = yield* ChatThreadRepo;
  return yield* repo.open(context);
});

/** Make one existing thread the chat's current one — what a *Switch* button does. */
export const switchThread = Effect.fn("bot.threads.switch")(function* (
  ref: ChatThreadRef
) {
  const repo = yield* ChatThreadRepo;
  return yield* repo.setCurrent(ref);
});

/**
 * Forget the provider's transcript for the current thread and keep the
 * conversation — what `/clear` does. Null when the chat has no thread yet,
 * which is a chat that has nothing to clear rather than an error.
 */
export const clearThread = Effect.fn("bot.threads.clear")(function* (
  chat: ChatRef
) {
  const repo = yield* ChatThreadRepo;
  const current = yield* repo.current(chat);
  return current === null
    ? null
    : yield* repo.clearProviderSession({
        id: current.id,
        workspaceId: current.workspaceId,
      });
});

/** A chat's conversations, most recently spoken in first. */
export const listThreads = Effect.fn("bot.threads.list")(function* (
  chat: ChatRef & { readonly limit?: number; readonly offset?: number }
) {
  const repo = yield* ChatThreadRepo;
  return yield* repo.listForChat(chat);
});

/**
 * What a thread is called in a list: its opening message, or a placeholder when
 * it has none yet. Already clipped by the store, so this only covers the null.
 */
export const threadTitle = (thread: Pick<ChatThread, "title">) =>
  thread.title === null || thread.title.trim() === ""
    ? UNTITLED_THREAD
    : thread.title.slice(0, THREAD_TITLE_MAX_CHARS);

/**
 * The label on a *Switch* button: a marker for the current one, the title, and
 * how long ago it was last spoken to.
 *
 * The age is on the button rather than in the message body because the button
 * is what a person reads when they are choosing, and six identical titles is a
 * list nobody can choose from.
 */
export const threadButtonLabel = (options: {
  readonly now: DateTime.Utc;
  readonly thread: Pick<ChatThread, "isCurrent" | "lastMessageAt" | "title">;
}) => {
  const { now, thread } = options;
  const marker = thread.isCurrent ? "● " : "";
  const age = formatRelativeTime({ at: thread.lastMessageAt, now });
  return `${marker}${threadTitle(thread).slice(0, BUTTON_TITLE_MAX_CHARS)} · ${age}`;
};

/**
 * The Telegram chat a grammy update came from, in the branded form every store
 * call takes. Validated rather than cast: the brand's check is what proves the
 * id is the integer the `bigint` column expects, and doing it here means no
 * handler below carries a bare number.
 */
export const telegramChatIdOf = (chatId: number) => TelegramChatId.make(chatId);

/** The current instant, in the form the formatters take. */
export const nowUtc = DateTime.now;
