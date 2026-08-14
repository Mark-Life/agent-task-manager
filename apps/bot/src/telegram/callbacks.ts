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
import { Clock, Effect, FiberSet, Option } from "effect";
import type { Bot } from "grammy";
import { CurrentChatProgress, observeChat } from "../chat-event";
import { Board } from "./board";
import type { BotService } from "./bot-service";
import { type CallbackData, decodeCallbackData } from "./callback-data";
import type { CommandServices } from "./commands";
import {
  COMPOSE_EMPTY_TEXT,
  COMPOSE_FAILED_TEXT,
  COMPOSE_GONE_ANSWER,
  type ComposeBuffers,
  closeCompose,
  composeCancelledText,
  composeSentText,
  showCompose,
} from "./compose";
import type { BotContext } from "./context";
import type { Dispatcher, PendingMessages } from "./dispatch";
import { italic } from "./format";
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

/** What a tap on a conversation another chat is holding is told. */
export const THREAD_HELD_ELSEWHERE_ANSWER =
  "That conversation is another chat's. Read it in the dashboard.";

/** What a tap on a conversation that is no longer there is told. */
export const THREAD_GONE_ANSWER = "That conversation is gone.";

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
  /** The per-chat compose buffers the two compose buttons act on. */
  readonly compose: ComposeBuffers;
  readonly pending: PendingMessages;
  /** The router's own append, so a released batch takes the path a message takes. */
  readonly submitCompose: Dispatcher["submitCompose"];
}

/**
 * What the taps need from the layer stack: the commands' services, plus the
 * bot itself — a released compose batch may land behind a live turn, and saying
 * so is a message into the chat.
 */
export type CallbackServices = BotService | CommandServices;

/**
 * Register every inline button on the bot.
 *
 * Registered after the access gate, like everything else: a handler here reads
 * `ctx.identity` and mints a credential from it.
 */
export const registerCallbacks = Effect.fnUntraced(function* (
  options: CallbackOptions
) {
  const { bot, compose, pending, submitCompose } = options;
  const board = yield* Board;
  const run = yield* FiberSet.makeRuntimePromise<CallbackServices>();

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
      yield* answer(ctx, "Send it as your next message.");
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

  /**
   * Release or drop a compose buffer — the two buttons on a compose message.
   *
   * Both endings close the buffer before anything else happens, so compose is
   * off from the moment the button is tapped and a second tap on the same
   * message finds nothing to send twice. An empty *Send* is not an error and not
   * a no-op either: it ends compose, because a person pressing Send on an empty
   * buffer is a person trying to get out of it.
   */
  const onCompose = Effect.fnUntraced(function* (input: {
    readonly ctx: BotContext;
    readonly chatId: number;
    readonly verb: "cmcxl" | "cmsnd";
  }) {
    const { chatId, ctx, verb } = input;
    const session = compose.close(chatId);
    if (session === null) {
      yield* answer(ctx, COMPOSE_GONE_ANSWER);
      return;
    }
    const waiting = session.pieces.length;
    const retire = (text: string) =>
      closeCompose({
        api: ctx.api,
        chatId,
        messageId: session.anchorMessageId,
        text,
      });

    if (verb === "cmcxl") {
      yield* retire(composeCancelledText(waiting));
      yield* observeChat({ outcome: "rejected" });
      yield* answer(ctx, "Compose cancelled.");
      return;
    }
    if (waiting === 0) {
      yield* retire(italic(COMPOSE_EMPTY_TEXT));
      yield* answer(ctx, COMPOSE_EMPTY_TEXT);
      return;
    }

    const submitted = yield* submitCompose({
      chatId,
      pieces: session.pieces,
      userId: ctx.identity.userId,
      workspaceId: ctx.identity.workspaceId,
    }).pipe(Effect.option);

    if (Option.isNone(submitted)) {
      const now = yield* Clock.currentTimeMillis;
      compose.restore({ chatId, now, session });
      yield* showCompose({
        api: ctx.api,
        chatId,
        messageId: session.anchorMessageId,
        waiting,
      });
      yield* answer(ctx, COMPOSE_FAILED_TEXT);
      return;
    }
    yield* retire(composeSentText(waiting));
    yield* answer(ctx, `Sent ${waiting} as one.`);
  });

  /**
   * Make one conversation this chat's current one.
   *
   * The list is the workspace's, so a tap can land on a conversation this chat
   * cannot have: one already being held in another chat. The store is what
   * decides that, and its refusal is answered as itself rather than as the
   * "gone" a missing row gets — a person who is told a conversation they can
   * see does not exist learns the wrong thing about the list.
   */
  const onSwitch = Effect.fnUntraced(function* (input: {
    readonly chatId: number;
    readonly ctx: BotContext;
    readonly threadId: ThreadId;
  }) {
    const { ctx } = input;
    const said = yield* switchThread({
      chatId: telegramChatIdOf(input.chatId),
      id: input.threadId,
      workspaceId: ctx.identity.workspaceId,
    }).pipe(
      Effect.map((thread) => `Switched to ${escapeHtml(threadTitle(thread))}.`),
      Effect.catchTag("Db.InvalidInput", () =>
        Effect.succeed(THREAD_HELD_ELSEWHERE_ANSWER)
      ),
      Effect.orElseSucceed(() => THREAD_GONE_ANSWER)
    );

    yield* answer(ctx, said);
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

        // Before the thread lookup: compose is a buffer in this process keyed
        // by the chat, and opening a conversation to answer *Cancel* would be a
        // conversation nobody asked for. The send path opens its own.
        if (data.kind === "compose") {
          yield* onCompose({ chatId, ctx, verb: data.verb });
          return;
        }

        const thread = yield* currentThread(ctx, chatId);

        if (data.kind === "task") {
          yield* onTask({ ctx, data, threadId: thread.id });
          return;
        }
        if (data.kind === "thread") {
          yield* data.verb === "thfs"
            ? onForceSend({ ctx, threadId: data.threadId })
            : onSwitch({ chatId, ctx, threadId: data.threadId });
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
