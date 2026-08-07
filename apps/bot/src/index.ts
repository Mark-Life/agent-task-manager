/**
 * The composition point: what is registered on the bot, in what order, and what
 * runs beside it. No handler logic lives here.
 *
 * **The order is the design.** The wide-event middleware is first, so a rejected
 * sender, a crashed handler and an interrupted turn each leave exactly one
 * `atm.chat` row. The access gate is second, so nothing below it runs for an
 * account nobody allow-listed and everything below it can read `ctx.identity`.
 * The commands are third, because the intake handler claims every message a
 * command did not — registered the other way round, `/tasks` reaches the manager
 * as the word "tasks", and `/compose` would be collected by the buffer it was
 * meant to open.
 *
 * **Three pieces of per-chat state are built here and shared by name.** The
 * queue notices, the armed comments and the compose buffers are each one map
 * per process, created once and handed to whichever handlers need them —
 * compose to all three of the router, the commands and the taps, because the
 * mode is opened by a command, fed by the router and released by a button.
 *
 * **The update is handled in a fiber grammy does not wait for.** grammy's
 * built-in poller runs updates one at a time (`for (const update of updates)
 * await this.handleUpdate(update)`), so awaiting a slow transcription here would
 * make the bot deaf to the `/stop` that follows it. The fibers live in a set the
 * program's scope owns, so a `SIGTERM` interrupts them rather than leaving them
 * behind.
 *
 * **Two long-lived fibers run beside the poller.** The notification listener
 * hears `atm_run_event` on the store's own connection — that is where a
 * finished worker run becomes a notice and a finished conversation turn becomes
 * an answer — and repairs undelivered claims on a tick; the stuck watch scans
 * live worker runs for one repeating itself. Both are forked into the same scope
 * and interrupted with it.
 */

import type { Telemetry } from "@workspace/telemetry";
import { Effect, FiberSet, type Ref } from "effect";
import type { ChatProgress, ChatUpdateKind } from "./chat-event";
import {
  CurrentChatProgress,
  makeChatProgress,
  observeChat,
  withChatEvent,
} from "./chat-event";
import type { BotWiring } from "./layers";
import { runNotifyListener } from "./notify";
import { StuckScan } from "./stuck/scan";
import { registerAccess } from "./telegram/access";
import { Allowlist, type AllowlistOps } from "./telegram/allowlist";
import { makeQueueNotices } from "./telegram/answer";
import { BotService } from "./telegram/bot-service";
import { registerCallbacks } from "./telegram/callbacks";
import { publishBotCommands, registerCommands } from "./telegram/commands";
import { makeComposeBuffers } from "./telegram/compose";
import type { BotContext } from "./telegram/context";
import { makeDispatcher, makePendingComments } from "./telegram/dispatch";
import { registerIntake } from "./telegram/intake";
import { makeKeyboardRefresh } from "./telegram/keyboard";

/**
 * What the raw update looks like before a handler classifies it.
 *
 * A guess, and it says so: the handler that really knows — the intake
 * classifier, the command wrapper, the callback handler — folds the answer in
 * with `observeChat` and wins. What this covers is the row written because no
 * handler ever ran, which is precisely the row of a refused sender.
 */
const guessUpdateKind = (ctx: BotContext): ChatUpdateKind => {
  if (ctx.callbackQuery !== undefined) {
    return "callback";
  }
  const { message } = ctx;
  if (message === undefined) {
    return "text";
  }
  if (message.voice !== undefined) {
    return "voice";
  }
  if (message.forward_origin !== undefined) {
    return "forward";
  }
  return message.text?.startsWith("/") === true ? "command" : "text";
};

/**
 * The immutable half of the row, read before any handler runs.
 *
 * The allow-list is consulted here as well as in the gate below, on purpose: the
 * row has to name the person even on the paths where nothing else does, and a
 * second lookup in an in-memory map is cheaper than two owners of the answer.
 */
const chatContextOf = (options: {
  readonly allowlist: AllowlistOps;
  readonly ctx: BotContext;
  readonly progress: Ref.Ref<ChatProgress>;
}) => {
  const { allowlist, ctx } = options;
  const telegramUserId = ctx.from?.id ?? 0;
  const entry = allowlist.lookup(telegramUserId);
  return {
    chatId: String(ctx.chat?.id ?? telegramUserId),
    progress: options.progress,
    telegramUserId: String(telegramUserId),
    updateKind: guessUpdateKind(ctx),
    userId: entry?.userId ?? null,
    workspaceId: entry?.workspaceId ?? null,
  };
};

/** What the update-handling fibers and the background fibers need. */
type UpdateServices = Telemetry;

/**
 * Registers every handler on the bot, in the order the module note gives.
 *
 * Separate from {@link runBot} because registration and *running* are different
 * things: this one is complete without a network, which is what lets
 * `bun run bot:check` drive the real handlers with synthetic updates and no
 * token. Scoped — the update fiber set belongs to the caller's scope, so closing
 * it interrupts an update in flight rather than orphaning it.
 */
export const registerHandlers = Effect.fnUntraced(function* (
  wiring: BotWiring
) {
  const allowlist = yield* Allowlist;
  const telegram = yield* BotService;
  const { bot } = telegram;

  const runUpdate = yield* FiberSet.makeRuntimePromise<UpdateServices>();

  // Every update funnels through this one wrap, which is what makes "one row per
  // update" a property of the process instead of something eight files
  // remembered. It returns before the work finishes; see the module note.
  bot.use((ctx, next) => {
    const handled = runUpdate(
      Effect.gen(function* () {
        const progress = yield* makeChatProgress;
        ctx.progress = progress;
        const context = chatContextOf({ allowlist, ctx, progress });
        return yield* Effect.promise(() => next()).pipe(withChatEvent(context));
      })
    );
    handled.catch(() => {
      // The row above already says how the update ended. Rethrowing here would
      // only reach grammy's default error handler, which logs it a second time.
    });
    return Promise.resolve();
  });

  registerAccess({
    allowlist,
    bot,
    botId: telegram.botId,
    onDenied: (ctx) =>
      runUpdate(
        observeChat({ outcome: "not_allowed", promptChars: 0 }).pipe(
          Effect.provideService(CurrentChatProgress, ctx.progress)
        )
      ).then(() => undefined),
  });

  const compose = makeComposeBuffers();
  const keyboards = makeKeyboardRefresh();
  const notices = makeQueueNotices();
  const pending = makePendingComments();
  const dispatcher = yield* makeDispatcher({
    api: telegram.api,
    botToken: wiring.botToken,
    compose,
    notices,
    pending,
  });

  yield* registerCommands({ bot, compose, keyboards, pending });
  yield* registerCallbacks({
    bot,
    compose,
    pending,
    submitCompose: dispatcher.submitCompose,
  });
  // Last: it claims every message the commands above did not.
  registerIntake(bot, dispatcher.handleUpdate);

  return {
    compose,
    dispatcher,
    keyboards,
    notices,
    pending,
    runUpdate,
    telegram,
  } as const;
});

/**
 * The whole bot: the handlers, the two background fibers, and the poller.
 *
 * Never returns on its own — the poller holds until the fiber is interrupted,
 * and the line on the way out is the operator's confirmation that the interrupt
 * was seen, written while the logger layer is still up.
 */
export const runBot = Effect.fnUntraced(function* (wiring: BotWiring) {
  const allowlist = yield* Allowlist;
  const scan = yield* StuckScan;
  const { keyboards, notices, runUpdate, telegram } =
    yield* registerHandlers(wiring);

  yield* Effect.forkScoped(
    runNotifyListener({
      keyboards,
      notices,
      repairIntervalMs: wiring.env.notifyRepairIntervalMs,
    })
  );
  yield* Effect.forkScoped(
    scan.watch({ workspaceIds: allowlist.workspaceIds })
  );

  yield* Effect.logInfo(
    "bot: handlers registered, listener and stuck watch running"
  );

  // Pending updates are dropped: a bot that was down for an hour would otherwise
  // wake up and file a row for every message it missed, all at once, and the
  // loop would spend a turn on each of them answering conversations that have
  // moved on.
  return yield* telegram
    .runPolling({
      dropPendingUpdates: true,
      onStart: () => runUpdate(publishBotCommands(telegram.api)),
    })
    .pipe(
      Effect.onInterrupt(() =>
        Effect.logInfo(
          "shutdown requested — stopping the poller, draining updates in flight, flushing telemetry"
        )
      )
    );
});
