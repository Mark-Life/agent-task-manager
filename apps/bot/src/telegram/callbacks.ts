/**
 * Every inline button, and the one rule they all obey: answer the tap.
 *
 * Telegram shows a spinner on a button until `answerCallbackQuery` comes back,
 * and a handler that returns without answering leaves it spinning until the
 * client gives up — which reads as a bot that hung. So every path here answers,
 * including the paths that refuse.
 *
 * The data on a button is parsed, never cast. It arrives from the client, an
 * old message can be tapped days after it was drawn, and a crafted update can
 * carry anything at all inside 64 bytes; `decodeCallbackData` proves the verb
 * and the id before a handler sees them, which is why the switch below has no
 * validation in it. An undecodable tap gets one sentence and nothing else
 * happens.
 *
 * A tapped button is attributed as `manager`, not `human`: the button is this
 * bot acting through a conversation with no interpretation in between, and
 * that is what puts the thread id on the audit row a tap causes. `human` means
 * the dashboard.
 */

import type { ThreadId } from "@workspace/domain";
import { Effect, FiberSet, Option } from "effect";
import type { Bot } from "grammy";
import { CurrentChatProgress, observeChat } from "../chat-event";
import { Board } from "./board";
import { type CallbackData, decodeCallbackData } from "./callback-data";
import type { CommandServices } from "./commands";
import type { BotContext } from "./context";
import type { PendingComments } from "./dispatch";
import { escapeHtml } from "./helpers";
import {
  ensureThread,
  switchThread,
  telegramChatIdOf,
  threadTitle,
} from "./threads";
import { type RenderedPage, renderPage } from "./views";

/** What a tap on a button minted by an older build is told. */
export const EXPIRED_CALLBACK_ANSWER = "That button has expired.";

/** How Telegram is told to parse a re-rendered page. */
const HTML = { parse_mode: "HTML" } as const;

/** Which status each task verb moves a task to. Absent for the run verbs. */
const TRANSITIONS = {
  tdone: "done",
  tprog: "in_progress",
  trev: "review",
} as const;

/** What registering the callbacks takes. */
export interface CallbackOptions {
  readonly bot: Bot<BotContext>;
  readonly pending: PendingComments;
}

/**
 * Register every inline button on the bot.
 *
 * Registered after the access gate, like everything else: a handler here reads
 * `ctx.identity` and mints a credential from it.
 */
export const registerCallbacks = Effect.fnUntraced(function* (
  options: CallbackOptions
) {
  const { bot, pending } = options;
  const board = yield* Board;
  const run = yield* FiberSet.makeRuntimePromise<CommandServices>();

  /** Answer the tap. Failure to answer is not worth failing the update over. */
  const answer = (ctx: BotContext, text: string) =>
    Effect.promise(() =>
      ctx
        .answerCallbackQuery({ text })
        .then(() => undefined)
        .catch(() => undefined)
    );

  /** Replace the message the button is attached to with a freshly drawn page. */
  const redraw = (ctx: BotContext, rendered: RenderedPage) =>
    Effect.promise(() =>
      ctx
        .editMessageText(rendered.text, {
          ...HTML,
          reply_markup: rendered.keyboard,
        })
        .then(() => undefined)
        .catch(() => undefined)
    );

  /** The chat's current thread, so every write a tap causes names a conversation. */
  const currentThread = (ctx: BotContext, chatId: number) =>
    ensureThread({
      chatId: telegramChatIdOf(chatId),
      userId: ctx.identity.userId,
      workspaceId: ctx.identity.workspaceId,
    });

  const actorOf = (ctx: BotContext, threadId: ThreadId) => ({
    threadId,
    userId: ctx.identity.userId,
    workspaceId: ctx.identity.workspaceId,
  });

  /** What a queued intervention is reported as, refusals included. */
  const queuedAnswer = (
    queued: Option.Option<{ readonly rejectedReason: string | null }>,
    verb: "rrun" | "rstop"
  ) => {
    if (Option.isNone(queued)) {
      return "That did not reach the board.";
    }
    const { rejectedReason } = queued.value;
    if (rejectedReason !== null) {
      return `Refused: ${rejectedReason}`;
    }
    return verb === "rstop" ? "Stop queued." : "Rerun queued.";
  };

  /** A move on the board, reported by what came back rather than by what was asked. */
  const onTask = Effect.fnUntraced(function* (input: {
    readonly ctx: BotContext;
    readonly data: Extract<CallbackData, { readonly kind: "task" }>;
    readonly threadId: ThreadId;
  }) {
    const { ctx, data, threadId } = input;
    const actor = actorOf(ctx, threadId);

    if (data.verb === "cadd") {
      pending.arm({ chatId: ctx.chat?.id ?? 0, taskId: data.taskId });
      yield* answer(ctx, "Send the comment as your next message.");
      return;
    }

    if (data.verb === "rstop" || data.verb === "rrun") {
      const queued = yield* (
        data.verb === "rstop"
          ? board.stopRun({ actor, taskId: data.taskId })
          : board.rerunTask({ actor, taskId: data.taskId })
      ).pipe(Effect.option);
      yield* answer(ctx, queuedAnswer(queued, data.verb));
      return;
    }

    const moved = yield* board
      .moveTask({ actor, taskId: data.taskId, to: TRANSITIONS[data.verb] })
      .pipe(Effect.option);
    yield* answer(
      ctx,
      Option.isNone(moved)
        ? "That move was refused."
        : `Moved to ${moved.value.status}.`
    );
  });

  /**
   * Stop the turn a conversation is waiting on — what *Force send* does.
   *
   * A stop naming the thread, filed on the same queue a human's Stop on a task
   * goes through. What was said while the turn ran is still unread, so the next
   * turn reads it; nothing is handed to a container from here.
   */
  const onForceSend = Effect.fnUntraced(function* (input: {
    readonly ctx: BotContext;
    readonly threadId: ThreadId;
  }) {
    const { ctx, threadId } = input;
    const queued = yield* board
      .stopThread({ actor: actorOf(ctx, threadId), threadId })
      .pipe(Effect.option);

    if (Option.isNone(queued)) {
      yield* answer(ctx, "That did not reach the board.");
      return;
    }
    const { rejectedReason } = queued.value;
    yield* answer(
      ctx,
      rejectedReason === null
        ? "Stopping this turn — the next one reads what is waiting."
        : `Refused: ${rejectedReason}`
    );
  });

  /** Make one conversation the chat's current one. */
  const onSwitch = Effect.fnUntraced(function* (input: {
    readonly ctx: BotContext;
    readonly threadId: ThreadId;
  }) {
    const { ctx } = input;
    const switched = yield* switchThread({
      id: input.threadId,
      workspaceId: ctx.identity.workspaceId,
    }).pipe(Effect.option);

    yield* answer(
      ctx,
      Option.isNone(switched)
        ? "That conversation is gone."
        : `Switched to ${escapeHtml(threadTitle(switched.value))}.`
    );
  });

  bot.on("callback_query:data", (ctx) =>
    run(
      Effect.gen(function* () {
        yield* observeChat({ updateKind: "callback" });
        const decoded = decodeCallbackData(ctx.callbackQuery.data);
        if (Option.isNone(decoded)) {
          yield* observeChat({ outcome: "rejected" });
          yield* answer(ctx, EXPIRED_CALLBACK_ANSWER);
          return;
        }
        const chatId = ctx.chat?.id;
        if (chatId === undefined) {
          yield* answer(ctx, EXPIRED_CALLBACK_ANSWER);
          return;
        }
        const data = decoded.value;
        const thread = yield* currentThread(ctx, chatId);

        if (data.kind === "task") {
          yield* onTask({ ctx, data, threadId: thread.id });
          return;
        }
        if (data.kind === "thread") {
          yield* (data.verb === "thfs" ? onForceSend : onSwitch)({
            ctx,
            threadId: data.threadId,
          });
          return;
        }

        const rendered = yield* renderPage({
          chatId,
          ctx,
          key: data.key,
          page: data.page,
          threadId: thread.id,
        });
        yield* redraw(ctx, rendered);
        yield* answer(ctx, "");
      }).pipe(
        // The runtime under `run` was built at boot; the cell this tap's row is
        // accumulated in comes off the context, which is what knows the update.
        Effect.provideService(CurrentChatProgress, ctx.progress)
      )
    )
  );
});
