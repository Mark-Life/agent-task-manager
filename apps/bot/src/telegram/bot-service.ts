/**
 * The grammy bot as a resource, and long polling as an interruptible effect.
 *
 * Construction and *running* are deliberately separate. The layer builds the
 * `Bot` and registers its teardown; handlers are registered on it afterwards by
 * the composition root, in an order that matters; and only then does something
 * call {@link BotService.runPolling}. A service that started polling as a side
 * effect of being constructed would be a service that receives updates before
 * the handlers for them exist.
 *
 * **Shutdown.** Two finalizers, one on top of the other. The scope's finalizer
 * calls `bot.stop()` so the bot is torn down even if it never polled — the case
 * where the process dies during layer build. Interrupting the polling fiber
 * calls it too, which is the ordinary path: `BunRuntime.runMain` interrupts the
 * root fiber on SIGTERM, `bot.stop()` tells grammy to finish the update it is
 * holding and stop asking for more, and the pending `getUpdates` long-poll is
 * cancelled rather than left to time out. Both paths swallow the one throw
 * grammy makes for "never started", which is not a condition anybody can act on.
 *
 * **What is not here.** No handler registration, no command list, no startup
 * message. This file knows the Telegram transport and nothing about what the
 * bot says.
 */

import { Context, Effect, Layer, Redacted } from "effect";
import { Bot } from "grammy";
import { botIdFromToken } from "./access";
import type { BotContext } from "./context";
import { type TelegramApiError, toTelegramApiError } from "./errors";
import type { SendMessageOptions } from "./send";

/**
 * A bot token that is not `<id>:<secret>` is a typo, an empty variable or a
 * quoted string — never a working token — so the layer refuses to build rather
 * than starting a process whose first Telegram call will fail with a 401.
 */
const requireBotId = (token: string) => {
  const botId = botIdFromToken(token);
  return botId === null
    ? Effect.die(new Error("TELEGRAM_BOT_TOKEN is not a bot token"))
    : Effect.succeed(botId);
};

/** Build the bot, and register the teardown that outlives every other failure. */
const makeBot = (token: Redacted.Redacted<string>) =>
  Effect.gen(function* () {
    const raw = Redacted.value(token);
    const botId = yield* requireBotId(raw);
    const bot = new Bot<BotContext>(raw);

    yield* Effect.acquireRelease(Effect.succeed(bot), () =>
      Effect.promise(() =>
        bot.stop().catch(() => {
          // grammy throws when the bot was never started. Nothing to stop.
        })
      )
    );

    /**
     * Long polling, held open until the fiber running it is interrupted.
     *
     * `bot.start` resolves only once the bot is stopped, so the effect is the
     * lifetime of the poller. The cleanup returned to `Effect.callback` is what
     * runs on interrupt, and it is the same `bot.stop()` the scope holds —
     * calling it twice is harmless and calling it never is a process that hangs
     * on SIGTERM waiting for a long-poll to expire.
     */
    const runPolling = (options?: {
      readonly dropPendingUpdates?: boolean;
      readonly onStart?: (
        me: Awaited<ReturnType<typeof bot.api.getMe>>
      ) => Promise<void>;
    }) =>
      Effect.callback<void, TelegramApiError>((resume) => {
        bot
          .start({
            drop_pending_updates: options?.dropPendingUpdates,
            onStart: (me) => options?.onStart?.(me),
          })
          .then(
            () => resume(Effect.void),
            (cause: unknown) =>
              resume(
                Effect.fail(toTelegramApiError({ cause, method: "getUpdates" }))
              )
          );
        return Effect.promise(() =>
          bot.stop().catch(() => {
            // Already stopped, or never started.
          })
        );
      });

    /** Send a message as an effect, with the transport's typed failure. */
    const send = (options: {
      readonly chatId: number;
      readonly send?: SendMessageOptions;
      readonly text: string;
    }) =>
      Effect.tryPromise({
        catch: (cause) => toTelegramApiError({ cause, method: "sendMessage" }),
        try: () =>
          bot.api.sendMessage(options.chatId, options.text, options.send),
      });

    return { api: bot.api, bot, botId, runPolling, send } as const;
  });

/**
 * The bot, its API and its poller.
 *
 * `layer` is a function of the token rather than a reader of the environment,
 * so the one place a secret is read stays the app's config module. It is also
 * why the layer must be named once as a value where it is composed: a layer is
 * memoised by identity, and two calls here would be two bots long-polling the
 * same token, which Telegram answers by dropping one of them at random.
 */
export class BotService extends Context.Service<
  BotService,
  Effect.Success<ReturnType<typeof makeBot>>
>()("@workspace/bot/BotService") {
  static readonly layer = (token: Redacted.Redacted<string>) =>
    Layer.effect(BotService, makeBot(token));
}
