/**
 * Every slash command, and the lists they draw.
 *
 * A command is the surface a person reaches for when they know what they want,
 * and there are only three kinds of them here. **Conversation** — `/new`,
 * `/compose`, `/threads`, `/switch`, `/history` — is the bot's own state, held
 * in Postgres and reached through the thread repository, except for `/compose`,
 * whose buffer is this process's. **Board** — `/tasks`, `/board`, `/stop`,
 * `/rerun`, `/next` — is not the bot's, and every one of them is a gateway call
 * under a freshly minted token; nothing here writes a task row or touches a
 * container. **Orientation** — `/start`, `/help`, `/status` — says where you
 * are.
 *
 * Commands keep working while a chat is composing, on purpose: the buffer holds
 * what a person is *saying*, and `/stop` or `/tasks` is not that. It is the
 * intake handler below these that a compose buffer intercepts, which is why
 * nothing in this file has to know about one — except `/compose` itself.
 *
 * The lists themselves are drawn in `./views`, because a tapped *Next* has to
 * redraw exactly what the command drew and both go through the same function
 * there.
 *
 * `/stop` is the one command with two meanings, and they are not ambiguous:
 * with a task id it queues a stop for that task's run, and with nothing it
 * queues one for the turn this conversation is waiting on. A person who types
 * `/stop` while the bot is thinking means the thinking. Both are the same row
 * on the same queue, which is why neither is a second way to kill a container.
 */

import {
  type ChatMessageRepo,
  type ChatThreadRepo,
  RunRepo,
  THREAD_TITLE_MAX_CHARS,
} from "@workspace/db";
import { TaskId } from "@workspace/domain";
import { Clock, DateTime, Effect, FiberSet, Option, Schema } from "effect";
import type { Api, Bot, InlineKeyboard } from "grammy";
import { CurrentChatProgress, observeChat } from "../chat-event";
import { actorFor, Board } from "./board";
import type { PageKey } from "./callback-data";
import {
  COMPOSE_MOVED_TEXT,
  type ComposeBuffers,
  closeCompose,
  composeKeyboard,
  composeText,
  showCompose,
} from "./compose";
import type { BotContext } from "./context";
import type { PendingComments } from "./dispatch";
import { bold, code, italic } from "./format";
import { escapeHtml, formatRelativeTime } from "./helpers";
import { mainKeyboard } from "./keyboard";
import { sendText } from "./send";
import {
  ensureThread,
  startThread,
  telegramChatIdOf,
  threadTitle,
} from "./threads";
import { type PageRequest, renderPage } from "./views";

/** How Telegram is told to parse everything this module composes. */
const HTML = { parse_mode: "HTML" } as const;

/**
 * The command list registered with Telegram at boot, which is what fills the
 * menu beside the text box. Ordered by how often a hand reaches for one, not
 * alphabetically: the menu is read top-down under a thumb.
 */
export const BOT_COMMANDS = [
  { command: "start", description: "Start here" },
  { command: "help", description: "What this bot can do" },
  { command: "status", description: "Live runs and this conversation" },
  { command: "tasks", description: "Tasks, newest column first" },
  { command: "board", description: "The board, column by column" },
  { command: "new", description: "Start a new conversation" },
  {
    command: "compose",
    description: "Collect several messages, send them as one",
  },
  { command: "threads", description: "Your conversations" },
  { command: "switch", description: "Switch to another conversation" },
  { command: "history", description: "What was said in this conversation" },
  { command: "stop", description: "Stop the turn, or a task's run" },
  { command: "rerun", description: "Run a task again" },
  { command: "next", description: "Move a task to the top of its column" },
] as const satisfies Parameters<Api["setMyCommands"]>[0];

/** The one message that explains the whole surface. */
export const HELP_TEXT = [
  bold("Talking to the manager"),
  "Send a message, a voice note or a forward. It becomes one turn of the conversation, and the manager works the board through it.",
  "",
  bold("Conversation"),
  `${code("/new")} — start a fresh conversation, with no session behind it`,
  `${code("/compose")} — collect several messages and send them as one turn`,
  `${code("/threads")} — your conversations, newest first`,
  `${code("/switch")} — make another conversation the current one`,
  `${code("/history")} — what was said here`,
  "",
  bold("Board"),
  `${code("/tasks")} — every task, by column`,
  `${code("/board")} — the board`,
  `${code("/stop")} — stop the turn in flight, so what is queued is read next`,
  `${code("/stop <taskId>")} — ask the orchestrator to stop that task's run`,
  `${code("/rerun <taskId>")} — run that task again`,
  `${code("/next <taskId>")} — move it to the top of its column, which is the queue`,
  "",
  bold("Orientation"),
  `${code("/start")} — the menu, and a conversation to say it in`,
  `${code("/status")} — live runs, and what this conversation is doing`,
].join("\n");

/**
 * The scopes the command list is published under.
 *
 * All four, because Telegram resolves a chat's menu by the most specific scope
 * that has one and falls back to `default` only when the others are empty — a
 * list registered under `default` alone is a menu that a group chat, having
 * once had its own, never sees again.
 */
const COMMAND_SCOPES = [
  { type: "default" },
  { type: "all_private_chats" },
  { type: "all_group_chats" },
  { type: "all_chat_administrators" },
] as const;

/**
 * Publish the command list to Telegram, which is what fills the menu beside
 * the text box. Called once at boot, from `onStart`.
 *
 * A failure is logged and swallowed: Telegram not accepting the menu is a bot
 * with a stale menu, not a bot that should refuse to start.
 */
export const publishBotCommands = Effect.fn("bot.commands.publish")(function* (
  api: Api
) {
  yield* Effect.forEach(
    COMMAND_SCOPES,
    (scope) =>
      Effect.tryPromise(() => api.setMyCommands(BOT_COMMANDS, { scope })),
    { concurrency: COMMAND_SCOPES.length, discard: true }
  ).pipe(
    Effect.tapError((error) =>
      Effect.logWarning("bot: could not publish the command list", error)
    ),
    Effect.ignore
  );
});

/** A task id a person typed, or `None` when they typed something else. */
const parseTaskId = Schema.decodeUnknownOption(TaskId);

/** What registering the commands takes. */
export interface CommandOptions {
  readonly bot: Bot<BotContext>;
  /** The per-chat compose buffers, which `/compose` opens. */
  readonly compose: ComposeBuffers;
  /** The armed comments, which opening compose spends. */
  readonly pending: PendingComments;
}

/** What the command handlers need from the layer stack. */
export type CommandServices =
  | Board
  | ChatMessageRepo
  | ChatThreadRepo
  | RunRepo;

/**
 * Register every command on the bot.
 *
 * Must be registered after `registerAccess`, which is what puts `ctx.identity`
 * on the context, and before the intake handler, which claims every message a
 * command did not.
 */
export const registerCommands = Effect.fnUntraced(function* (
  options: CommandOptions
) {
  const { bot, compose, pending } = options;
  const board = yield* Board;
  const runs = yield* RunRepo;
  const run = yield* FiberSet.makeRuntimePromise<CommandServices>();

  /**
   * Run one command's work, naming it on this update's row first. The name is
   * the whole reason this wrapper exists: `commandName` is what makes "which
   * command is failing" one query rather than a guess from the update kind.
   *
   * The row's cell comes off the context: the runtime under `run` was built at
   * boot and knows nothing about the update being handled, so what an
   * `observeChat` deep inside the work folds into has to be handed down from
   * here.
   */
  const runCommand = <E>(
    ctx: BotContext,
    name: string,
    work: Effect.Effect<void, E, CommandServices>
  ) =>
    run(
      observeChat({ commandName: name, updateKind: "command" }).pipe(
        Effect.andThen(work),
        Effect.provideService(CurrentChatProgress, ctx.progress)
      )
    );

  /** Reply with markup this module composed, never with a model's markdown. */
  const say = (ctx: BotContext, text: string, keyboard?: InlineKeyboard) =>
    Effect.promise(() =>
      ctx
        .reply(text, {
          ...HTML,
          ...(keyboard ? { reply_markup: keyboard } : {}),
        })
        .then(() => undefined)
        .catch(() => undefined)
    );

  /** Draw a list from scratch, in a new message. */
  const sendPage = Effect.fnUntraced(function* (request: PageRequest) {
    const rendered = yield* renderPage(request);
    yield* say(request.ctx, rendered.text, rendered.keyboard);
  });

  /** The chat's current thread, opening one when there is none. */
  const currentThread = (ctx: BotContext, chatId: number) =>
    ensureThread({
      chatId: telegramChatIdOf(chatId),
      userId: ctx.identity.userId,
      workspaceId: ctx.identity.workspaceId,
    });

  /** The task id an argument names, or a sentence saying it did not. */
  const withTaskId = Effect.fnUntraced(function* (options_: {
    readonly ctx: BotContext;
    readonly onTask: (taskId: TaskId) => Effect.Effect<void, never, never>;
    readonly usage: string;
    readonly raw: string;
  }) {
    const parsed = parseTaskId(options_.raw.trim());
    if (Option.isNone(parsed)) {
      yield* say(options_.ctx, `${italic(options_.usage)}`);
      return;
    }
    yield* options_.onTask(parsed.value);
  });

  /** Report what the gateway did with a queued intervention, refusals included. */
  const reportCommand = (
    ctx: BotContext,
    queued: { readonly rejectedReason: string | null },
    done: string
  ) =>
    say(
      ctx,
      queued.rejectedReason === null
        ? done
        : `Refused: ${escapeHtml(queued.rejectedReason)}`
    );

  bot.command("start", (ctx) =>
    runCommand(
      ctx,
      "start",
      Effect.gen(function* () {
        const chatId = ctx.chat?.id;
        if (chatId === undefined) {
          return;
        }
        yield* currentThread(ctx, chatId);
        yield* Effect.promise(() =>
          ctx
            .reply(
              `${bold("Agent task manager")}\nSend a message, a voice note or a forward and the manager works the board through it.\n\n${italic("/help for everything else")}`,
              { ...HTML, reply_markup: mainKeyboard }
            )
            .then(() => undefined)
            .catch(() => undefined)
        );
      })
    )
  );

  bot.command("help", (ctx) => runCommand(ctx, "help", say(ctx, HELP_TEXT)));

  bot.command("status", (ctx) =>
    runCommand(
      ctx,
      "status",
      Effect.gen(function* () {
        const chatId = ctx.chat?.id;
        if (chatId === undefined) {
          return;
        }
        const thread = yield* currentThread(ctx, chatId);
        const live = yield* runs.listLive({
          workspaceId: ctx.identity.workspaceId,
        });
        const turn = yield* runs.liveForThread({
          threadId: thread.id,
          workspaceId: thread.workspaceId,
        });
        const now = yield* DateTime.now;
        yield* say(
          ctx,
          [
            `${bold(threadTitle(thread))}`,
            `provider: ${code(thread.provider)}`,
            `last message: ${formatRelativeTime({ at: thread.lastMessageAt, now })}`,
            turn === null
              ? `turn: ${italic("idle")}`
              : `turn: ${italic(turn.status)} since ${formatRelativeTime({ at: turn.createdAt, now })}`,
            "",
            `${bold("Live runs")}: ${live.length}`,
            ...live.map(
              (entry) =>
                `${code(entry.taskId ?? entry.threadId ?? entry.id)} ${entry.status}`
            ),
          ].join("\n")
        );
      })
    )
  );

  bot.command("new", (ctx) =>
    runCommand(
      ctx,
      "new",
      Effect.gen(function* () {
        const chatId = ctx.chat?.id;
        if (chatId === undefined) {
          return;
        }
        yield* startThread({
          chatId: telegramChatIdOf(chatId),
          userId: ctx.identity.userId,
          workspaceId: ctx.identity.workspaceId,
        });
        yield* say(
          ctx,
          "New conversation, with no session behind it. The old one is still in /threads."
        );
      })
    )
  );

  /**
   * Open a compose buffer, or bring an open one's buttons back within reach.
   *
   * A second `/compose` after twenty forwards is somebody who has scrolled past
   * the anchor, not somebody starting over — so the words are kept and a fresh
   * anchor is sent at the bottom, with the old one's buttons stripped. Two live
   * send buttons over one buffer is a tap whose effect depends on how far the
   * chat has scrolled.
   */
  bot.command("compose", (ctx) =>
    runCommand(
      ctx,
      "compose",
      Effect.gen(function* () {
        const chatId = ctx.chat?.id;
        if (chatId === undefined) {
          return;
        }
        // An armed *Comment* would otherwise consume the first message of the
        // batch, or worse, the one sent after it was released.
        pending.take(chatId);

        const now = yield* Clock.currentTimeMillis;
        const sent = yield* sendText({
          api: ctx.api,
          chatId,
          send: { ...HTML, reply_markup: composeKeyboard(0) },
          text: composeText(0),
        }).pipe(Effect.orElseSucceed(() => []));

        const anchorMessageId = sent.at(-1)?.message_id;
        if (anchorMessageId === undefined) {
          // No anchor means no buttons, and a buffer nobody could release.
          return;
        }
        const displaced = compose.open({ anchorMessageId, chatId, now });
        if (displaced !== null) {
          yield* closeCompose({
            api: ctx.api,
            chatId,
            messageId: displaced.anchorMessageId,
            text: COMPOSE_MOVED_TEXT,
          });
          yield* showCompose({
            api: ctx.api,
            chatId,
            messageId: anchorMessageId,
            waiting: displaced.pieces.length,
          });
        }
      })
    )
  );

  const listCommand = (name: string, key: PageKey) => (ctx: BotContext) =>
    runCommand(
      ctx,
      name,
      Effect.gen(function* () {
        const chatId = ctx.chat?.id;
        if (chatId === undefined) {
          return;
        }
        const thread = yield* currentThread(ctx, chatId);
        yield* sendPage({ chatId, ctx, key, page: 0, threadId: thread.id });
      })
    );

  bot.command("threads", listCommand("threads", "threads"));
  bot.command("switch", listCommand("switch", "threads"));
  bot.command("history", listCommand("history", "history"));
  bot.command("tasks", listCommand("tasks", "tasks"));
  bot.command("board", listCommand("board", "board"));

  bot.command("stop", (ctx) =>
    runCommand(
      ctx,
      "stop",
      Effect.gen(function* () {
        const chatId = ctx.chat?.id;
        if (chatId === undefined) {
          return;
        }
        const raw = (ctx.match ?? "").trim();
        if (raw === "") {
          const thread = yield* currentThread(ctx, chatId);
          yield* board
            .stopThread({
              actor: actorFor({ ctx, threadId: thread.id }),
              threadId: thread.id,
            })
            .pipe(
              Effect.flatMap((queued) =>
                reportCommand(
                  ctx,
                  queued,
                  "Stopping this turn — the next one reads what is waiting."
                )
              ),
              Effect.catch((error) => say(ctx, escapeHtml(error.message)))
            );
          return;
        }
        const thread = yield* currentThread(ctx, chatId);
        yield* withTaskId({
          ctx,
          onTask: (taskId) =>
            board
              .stopRun({
                actor: actorFor({ ctx, threadId: thread.id }),
                taskId,
              })
              .pipe(
                Effect.flatMap((queued) =>
                  reportCommand(ctx, queued, "Stop queued.")
                ),
                Effect.catch((error) => say(ctx, escapeHtml(error.message)))
              ),
          raw,
          usage: "Usage: /stop, or /stop <taskId>",
        });
      })
    )
  );

  bot.command("rerun", (ctx) =>
    runCommand(
      ctx,
      "rerun",
      Effect.gen(function* () {
        const chatId = ctx.chat?.id;
        if (chatId === undefined) {
          return;
        }
        const thread = yield* currentThread(ctx, chatId);
        yield* withTaskId({
          ctx,
          onTask: (taskId) =>
            board
              .rerunTask({
                actor: actorFor({ ctx, threadId: thread.id }),
                taskId,
              })
              .pipe(
                Effect.flatMap((queued) =>
                  reportCommand(ctx, queued, "Rerun queued.")
                ),
                Effect.catch((error) => say(ctx, escapeHtml(error.message)))
              ),
          raw: ctx.match ?? "",
          usage: "Usage: /rerun <taskId>",
        });
      })
    )
  );

  bot.command("next", (ctx) =>
    runCommand(
      ctx,
      "next",
      Effect.gen(function* () {
        const chatId = ctx.chat?.id;
        if (chatId === undefined) {
          return;
        }
        const thread = yield* currentThread(ctx, chatId);
        yield* withTaskId({
          ctx,
          onTask: (taskId) =>
            board
              .placeTask({
                actor: actorFor({ ctx, threadId: thread.id }),
                after: null,
                taskId,
              })
              .pipe(
                Effect.flatMap((task) =>
                  say(
                    ctx,
                    `${escapeHtml(task.title.slice(0, THREAD_TITLE_MAX_CHARS))} is now top of ${code(task.status)}.`
                  )
                ),
                Effect.catch((error) => say(ctx, escapeHtml(error.message)))
              ),
          raw: ctx.match ?? "",
          usage: "Usage: /next <taskId>",
        });
      })
    )
  );
});
