/**
 * The composition root. Every service the bot runs on is built here, once, and
 * finalized once.
 *
 * The build order is the dependency order, bottom up:
 *
 *   platform (Bun's filesystem, path, crypto, child processes)
 *     └─ telemetry — logger, the JSONL ledger, the config-gated OTLP forwarder
 *          └─ the chat store, the allow-list, the grammy bot, the board client,
 *             transcription
 *               └─ the notifier
 *                    └─ the stuck watch
 *
 * Two things about this file are load-bearing rather than stylistic.
 *
 * **`BotService.layer` is named once, as a value.** A layer is memoised by
 * identity, so two calls would be two processes long-polling one token — which
 * Telegram answers by delivering each update to one of them at random.
 *
 * **There is no `CurrentActor`.** `chatStoreLayer` hands over the three chat
 * tables plus read access to runs, tasks and the audit log, and every mutating
 * repository method needs an actor this process never provides. So the rule that
 * the bot owns the conversation and the gateway owns the board is a compile
 * error here, not a convention: a board write from this app names the missing
 * service instead of quietly landing without an author. The way to the board is
 * {@link Board}, over HTTP, with a token that carries the conversation.
 */

import { BunServices } from "@effect/platform-bun";
import { chatStoreLayer } from "@workspace/db";
import type { TaskId } from "@workspace/domain";
import { ServerEnv } from "@workspace/env/server";
import { EventLog, telemetryLayer } from "@workspace/telemetry";
import {
  makeTokenSigner,
  mintAgentToken,
  type TokenSigner,
} from "@workspace/token";
import { type Context, Effect, Layer, Option, Schema } from "effect";
import { SERVICE_NAME } from "./identity";
import { Notifier, stuckAnnouncerLayer } from "./notify";
import { StuckScan } from "./stuck/scan";
import { Allowlist } from "./telegram/allowlist";
import { Board, BoardError, type MintManagerToken } from "./telegram/board";
import { BotService } from "./telegram/bot-service";
import { TranscribeService } from "./transcribe";

/** The resolved environment, derived from the service so it cannot be restated. */
export type BotEnv = Context.Service.Shape<typeof ServerEnv>;

/**
 * A variable the bot cannot start without.
 *
 * Its own failure rather than a `Config` miss, because the two required
 * variables are required by *this app* and optional in the shared environment —
 * a bot that started without an allow-list would answer nobody while looking
 * perfectly healthy.
 */
export class BotNotConfigured extends Schema.TaggedErrorClass<BotNotConfigured>()(
  "Bot.NotConfigured",
  { variable: Schema.String }
) {
  override get message() {
    return `${this.variable} is required by apps/bot`;
  }
}

/** The one required value, or the name of the variable that is missing. */
const required = <A>(value: Option.Option<A>, variable: string) =>
  Option.isNone(value)
    ? Effect.fail(new BotNotConfigured({ variable }))
    : Effect.succeed(value.value);

/**
 * Everything the layers are built from, read once.
 *
 * Resolved before any layer is built rather than inside one, so a missing token
 * is a message at boot instead of a stack trace from a layer that half
 * succeeded — and so the entrypoint can print a banner naming the settings it is
 * about to run on.
 */
export const botWiring = Effect.gen(function* () {
  const env = yield* ServerEnv;
  const botToken = yield* required(env.telegramBotToken, "TELEGRAM_BOT_TOKEN");
  const allowlist = yield* required(
    env.telegramAllowlist,
    "TELEGRAM_ALLOWLIST"
  );
  // Read once, here. A tapped button mints against it, and a second read of
  // `BETTER_AUTH_SECRET` would be a second chance to disagree about the key
  // this deployment signs with.
  const signer = yield* makeTokenSigner;
  return { allowlist, botToken, env, signer } as const;
}).pipe(Effect.provide(ServerEnv.layer));

/** What the layer stack is built from. Derived from the read above. */
export interface BotWiring extends Effect.Success<typeof botWiring> {}

/**
 * The signing key's answer, in the vocabulary a chat handler can print.
 *
 * A refused mint means this process asked for more than a `manager` actor may
 * hold, which is a bug rather than a thing a person did — but it reaches them as
 * a failed button either way, so it arrives sanitized like every other board
 * failure.
 *
 * The same mint the loop uses for an agent turn, with a manager binding: one
 * spelling of how a credential is made for an actor, and the button's reach is
 * the conversation's.
 */
const mintFor =
  (signer: TokenSigner) => (actor: Parameters<MintManagerToken>[0]) =>
    mintAgentToken({
      binding: {
        kind: "manager",
        threadId: actor.threadId,
        userId: actor.userId,
      },
      signer,
      workspaceId: actor.workspaceId,
    }).pipe(
      Effect.mapError(
        (cause) => new BoardError({ detail: cause.message, operation: "mint" })
      )
    );

/**
 * The logger, the durable ledger and the OTLP forwarder, over Bun's platform
 * services.
 *
 * The second `EventLog` is a read handle, not a second writer: the emitter
 * inside `telemetryLayer` owns the appends, and this one exists so the banner
 * can print the path an operator points `bun run logs` at instead of the app
 * recomputing it from `DATA_ROOT` and getting it subtly wrong.
 */
const observabilityLayer = Layer.mergeAll(
  telemetryLayer({ serviceName: SERVICE_NAME }),
  EventLog.layer({ serviceName: SERVICE_NAME })
).pipe(Layer.provideMerge(BunServices.layer));

/**
 * What everything above runs on: the store, who is allowed to talk to it, the
 * transport, the board and transcription.
 *
 * There is no sandbox here and there must not be. This process starts no
 * container: a message becomes a row, the orchestrator claims the thread, and
 * the only way from here to the board is HTTP.
 */
const infrastructureLayer = (
  wiring: BotWiring,
  substitutes: AppSubstitutes = {}
) =>
  Layer.mergeAll(
    Allowlist.layer(wiring.allowlist),
    substitutes.board ??
      Board.layer({
        // The gateway as *this process* reaches it, which is not the address a
        // container resolves; the loop reads its own.
        baseUrl: wiring.env.botGatewayUrl,
        mint: mintFor(wiring.signer),
      }),
    BotService.layer(wiring.botToken),
    substitutes.transcribe ?? TranscribeService.layer,
    chatStoreLayer({ applicationName: SERVICE_NAME })
  ).pipe(Layer.provideMerge(observabilityLayer));

/** A configured origin may or may not end in a slash; the link may not have two. */
const TRAILING_SLASHES = /\/+$/;

/**
 * Where a person clicks to see a task, or nothing when this deployment has no
 * origin to send them to.
 *
 * The dashboard's origin is the right answer and the gateway's is the fallback,
 * because `/tasks/<id>` is a page the dashboard renders and the gateway has no
 * static assets to answer it with. The fallback stays for the deployment that
 * puts both behind one host, where the two values are the same string anyway.
 */
const taskUrlFor = (origins: {
  readonly dashboard: Option.Option<string>;
  readonly gateway: Option.Option<string>;
}) => {
  const origin = Option.orElse(origins.dashboard, () => origins.gateway);
  return (taskId: TaskId) =>
    Option.match(origin, {
      onNone: () => null,
      onSome: (base) => `${base.replace(TRAILING_SLASHES, "")}/tasks/${taskId}`,
    });
};

/**
 * The two services a check may stand in for, because they are the two that
 * reach off the machine: the gateway, which is a second process, and Groq,
 * which is a paid API with a key this process may not even hold.
 *
 * Everything else — the store, the allow-list, the grammy client, the router —
 * is exercised as itself. Production passes neither and gets both for real.
 */
export interface AppSubstitutes {
  readonly board?: Layer.Layer<Board>;
  readonly transcribe?: Layer.Layer<TranscribeService>;
}

/**
 * The whole process, as one layer.
 *
 * Provide it to the entrypoint and nothing else: a second build would mean a
 * second connection pool, a second ledger handle and a second poller all
 * claiming to be this bot. Everything is merged out rather than hidden, because
 * the entrypoint legitimately reaches most of it — it registers the handlers on
 * the bot, forks the listener on the pool's own `PgClient`, and starts the scan.
 */
export const appLayer = (wiring: BotWiring, substitutes?: AppSubstitutes) =>
  StuckScan.layer.pipe(Layer.provide(stuckAnnouncerLayer)).pipe(
    Layer.provideMerge(
      Notifier.layer({
        retryGraceMs: wiring.env.notifyRetryGraceMs,
        splitAt: wiring.env.botSplitAt,
        taskUrl: taskUrlFor({
          dashboard: wiring.env.dashboardOrigin,
          gateway: wiring.env.gatewayPublicUrl,
        }),
      })
    ),
    Layer.provideMerge(infrastructureLayer(wiring, substitutes))
  );
