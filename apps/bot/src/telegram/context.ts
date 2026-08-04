/**
 * The grammy context every handler in this app receives, and the two fields this
 * app adds to it.
 *
 * grammy's own `Context` knows about Telegram and nothing else. Who the sender
 * is *to this system* — which workspace their writes land in, which user id the
 * audit log will carry — is resolved exactly once, by the access middleware, and
 * hung on the context so no handler below re-derives it. A handler that reads
 * `ctx.identity` is reading a decision already made, not making one.
 *
 * `progress` is the same idea for telemetry: the row this update will leave is
 * accumulated in one cell, created by the outermost middleware and carried on
 * the context because the handlers below it run on runtimes built at boot, which
 * cannot see anything a later fiber provided. Each handler's entry point hands
 * this cell to the work under it, and `observeChat` folds into it from there.
 *
 * Both properties are declared non-optional deliberately. Both are present for
 * every handler registered *after* the composition root's first two middlewares,
 * and registering one before them is the mistake this file cannot prevent but
 * the composition root can: the order is fixed in one place.
 */

import type { UserId, WorkspaceId } from "@workspace/domain";
import type { Ref } from "effect";
import type { Context } from "grammy";
import type { ChatProgress } from "../chat-event";

/** Who the Telegram sender is in this system, resolved from the allow-list. */
export interface ChatIdentity {
  /** The Telegram account that sent the update. Never a workspace key. */
  readonly telegramUserId: number;
  readonly userId: UserId;
  readonly workspaceId: WorkspaceId;
}

/** grammy's context, plus what this app resolved before any handler ran. */
export interface BotContext extends Context {
  identity: ChatIdentity;
  /** What this update has learned so far. Read once, as its row is written. */
  progress: Ref.Ref<ChatProgress>;
}
