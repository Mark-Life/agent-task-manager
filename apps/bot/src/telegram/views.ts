/**
 * The lists this bot draws, each one fetched and rendered by a single function.
 *
 * A list is drawn twice: once by the command that asked for it, and again in
 * place every time a *Prev* or *Next* button is tapped. Those two are the same
 * call here — {@link renderPage} takes the key off the button and answers with
 * a message and the keyboard under it — because two spellings of "the threads
 * page" is how a list changes in one place and not the other.
 *
 * Fetching and rendering are together rather than split, deliberately: the page
 * a button asks for decides how much to fetch, and a renderer handed a list
 * somebody else paged is a renderer that cannot say `(2/5)` honestly.
 *
 * Everything composed here is Telegram HTML, and every interpolated value goes
 * through `escapeHtml` on the way in. A task title is somebody's text.
 */

import { ChatMessageRepo } from "@workspace/db";
import type { ThreadId } from "@workspace/domain";
import { DateTime, Effect } from "effect";
import { InlineKeyboard } from "grammy";
import { actorFor, Board } from "./board";
import { encodeCallbackData, type PageKey } from "./callback-data";
import type { BotContext } from "./context";
import { bold, code, TASK_STATUS_ICONS, taskLine } from "./format";
import { escapeHtml } from "./helpers";
import { appendNavRow, navKeyboard, pageIndicator, paginate } from "./paging";
import {
  ensureThread,
  listThreads,
  telegramChatIdOf,
  threadButtonLabel,
  threadTitle,
} from "./threads";

/** How many threads or messages a list reaches back over. */
const THREAD_LIST_LIMIT = 60;

/** How much of a message the history list shows before it clips. */
const HISTORY_LINE_MAX_CHARS = 120;

/** What every page builder answers with: a message and the keyboard under it. */
export interface RenderedPage {
  readonly keyboard: InlineKeyboard;
  readonly text: string;
}

/**
 * The chat's conversations, one page at a time, each row a button that switches
 * to it. The list is a keyboard rather than text with ids beside it because
 * switching by typing a uuid is not a thing anybody does.
 */
export const threadsPage = Effect.fnUntraced(function* (options: {
  readonly chatId: number;
  readonly ctx: BotContext;
  readonly page: number;
}) {
  const threads = yield* listThreads({
    chatId: telegramChatIdOf(options.chatId),
    limit: THREAD_LIST_LIMIT,
    workspaceId: options.ctx.identity.workspaceId,
  });
  const now = yield* DateTime.now;
  const page = paginate({ items: threads, page: options.page });

  const keyboard = new InlineKeyboard([]);
  for (const thread of page.items) {
    keyboard.row(
      InlineKeyboard.text(
        threadButtonLabel({ now, thread }),
        encodeCallbackData({
          kind: "thread",
          threadId: thread.id,
          verb: "thsw",
        })
      )
    );
  }

  return {
    keyboard: appendNavRow({ key: "threads", keyboard, page }),
    text: page.isEmpty
      ? "No conversations yet. Send a message to start one."
      : `${bold("Conversations")}${pageIndicator(page)}`,
  } satisfies RenderedPage;
});

/** What was said in the current conversation, oldest first. */
export const historyPage = Effect.fnUntraced(function* (options: {
  readonly chatId: number;
  readonly ctx: BotContext;
  readonly page: number;
}) {
  const messages = yield* ChatMessageRepo;
  const thread = yield* ensureThread({
    chatId: telegramChatIdOf(options.chatId),
    userId: options.ctx.identity.userId,
    workspaceId: options.ctx.identity.workspaceId,
  });
  const rows = yield* messages.listForThread({
    limit: THREAD_LIST_LIMIT,
    threadId: thread.id,
    workspaceId: thread.workspaceId,
  });
  const page = paginate({ items: rows, page: options.page });
  const lines = page.items.map(
    (row) =>
      `${row.role === "user" ? "🧑" : "🤖"} ${escapeHtml(row.body.slice(0, HISTORY_LINE_MAX_CHARS))}`
  );

  return {
    keyboard: navKeyboard({ key: "history", page }),
    text: page.isEmpty
      ? `${bold(threadTitle(thread))}\nNothing said here yet.`
      : [
          `${bold(threadTitle(thread))}${pageIndicator(page)}`,
          "",
          ...lines,
        ].join("\n"),
  } satisfies RenderedPage;
});

/** Every task in the workspace, one page at a time. */
export const tasksPage = Effect.fnUntraced(function* (options: {
  readonly ctx: BotContext;
  readonly page: number;
  readonly threadId: ThreadId | null;
}) {
  const board = yield* Board;
  const tasks = yield* board.listTasks({
    actor: actorFor({ ctx: options.ctx, threadId: options.threadId }),
  });
  const page = paginate({ items: tasks, page: options.page });

  return {
    keyboard: navKeyboard({ key: "tasks", page }),
    text: page.isEmpty
      ? "No tasks yet."
      : [
          `${bold("Tasks")}${pageIndicator(page)}`,
          "",
          ...page.items.map((task) =>
            taskLine({ id: task.id, status: task.status, title: task.title })
          ),
        ].join("\n\n"),
  } satisfies RenderedPage;
});

/**
 * The board as one list, each card under the column it sits in. Flattened
 * rather than five messages: a column at a time is five notifications for one
 * question.
 */
export const boardPage = Effect.fnUntraced(function* (options: {
  readonly ctx: BotContext;
  readonly page: number;
  readonly threadId: ThreadId | null;
}) {
  const board = yield* Board;
  const columns = yield* board.columns({
    actor: actorFor({ ctx: options.ctx, threadId: options.threadId }),
  });
  const cards = columns.flatMap((column) =>
    column.tasks.map((task) => ({ column: column.status, task }))
  );
  const page = paginate({ items: cards, page: options.page });

  return {
    keyboard: navKeyboard({ key: "board", page }),
    text: page.isEmpty
      ? "The board is empty."
      : [
          `${bold("Board")}${pageIndicator(page)}`,
          "",
          ...page.items.map(
            (card) =>
              `${TASK_STATUS_ICONS[card.column]} ${bold(card.task.title)}\n${code(card.task.id)}`
          ),
        ].join("\n\n"),
  } satisfies RenderedPage;
});

/** What the router and the callbacks both need to draw a page by its key. */
export interface PageRequest {
  readonly chatId: number;
  readonly ctx: BotContext;
  readonly key: PageKey;
  readonly page: number;
  readonly threadId: ThreadId | null;
}

/**
 * Draw the page a key names. One function, so a *Next* button and the command
 * that drew the first page cannot disagree about what the list is.
 */
export const renderPage = (request: PageRequest) => {
  switch (request.key) {
    case "threads":
      return threadsPage(request);
    case "history":
      return historyPage(request);
    case "tasks":
      return tasksPage(request);
    default:
      return boardPage(request);
  }
};
