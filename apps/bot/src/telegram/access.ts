/**
 * The gate every update passes through, and the only place identity is decided.
 *
 * Three things happen here, in this order, and the order is the design.
 *
 * **Updates from a bot are dropped without a word.** Including this bot's own:
 * a bot that answers itself in a group is a loop that runs until Telegram rate
 * limits it.
 *
 * **An unknown Telegram account gets one sentence and no processing.** It also
 * gets a row. A rejection recorded as a `console.log` is a rejection nobody
 * ever counts, and "why did the bot ignore me" is exactly the question the
 * ledger should answer — so denial is reported through the caller's hook rather
 * than swallowed here. What the hook does with it is the composition root's
 * business; that this file calls it on every miss is this file's.
 *
 * **A known account is resolved once.** `ctx.identity` carries the workspace
 * every write below lands in and the user id the audit log will name, so no
 * handler re-derives it and no handler can accidentally derive it differently.
 * Everything registered after `registerAccess` may read it; registering
 * anything before is the mistake this file cannot catch, which is why the whole
 * registration order lives in one file above.
 *
 * The identity is not a credential. The manager's gateway token is minted per
 * turn from this same pair, and the gateway checks it there — this middleware
 * decides who is speaking, not what they may do.
 */

import type { Bot } from "grammy";
import type { AllowlistOps } from "./allowlist";
import type { BotContext } from "./context";
import { rewriteButtonCommands } from "./keyboard";

/** What an account that is not on the list is told. */
export const NOT_ALLOWED_REPLY = "This bot is not configured for your account.";

/**
 * Register the access gate and the reply-keyboard rewrite, in that order.
 *
 * `botId` is the numeric prefix of the bot token, which the caller already has;
 * asking Telegram for it with `getMe` would make the composition root wait on a
 * network call to register a middleware.
 *
 * `onDenied` is called for every rejected update and is expected to record it.
 * It returns a promise so the caller can run an effect through its own runtime;
 * a rejection from it is not allowed to break the middleware chain, so it is
 * caught and dropped here — a denial that fails to be *recorded* must still be
 * a denial.
 */
export const registerAccess = (options: {
  readonly allowlist: AllowlistOps;
  readonly bot: Bot<BotContext>;
  readonly botId: number;
  readonly onDenied: (ctx: BotContext) => Promise<void>;
}) => {
  const { allowlist, bot, botId, onDenied } = options;

  bot.use(async (ctx, next) => {
    const { from } = ctx;
    if (from === undefined || from.is_bot || from.id === botId) {
      return;
    }
    const entry = allowlist.lookup(from.id);
    if (entry === null) {
      await onDenied(ctx).catch(() => {
        // The reply below is the part the person sees; a failed recording
        // must not turn a denial into a silent pass.
      });
      await ctx.reply(NOT_ALLOWED_REPLY).catch(() => {
        // Blocked the bot, deleted the chat, or is being rate limited.
      });
      return;
    }
    ctx.identity = {
      telegramUserId: from.id,
      userId: entry.userId,
      workspaceId: entry.workspaceId,
    };
    await next();
  });

  bot.use(rewriteButtonCommands);
};

/**
 * The numeric part of a bot token, which is the bot's own Telegram user id.
 *
 * Parsed rather than looked up because it is the one fact a token states in
 * plain text. Null when the token is not in `<id>:<secret>` form at all, which
 * the caller treats as a token it should not start with.
 */
export const botIdFromToken = (token: string) => {
  const parsed = Number.parseInt(token.split(":")[0] ?? "", 10);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : null;
};
