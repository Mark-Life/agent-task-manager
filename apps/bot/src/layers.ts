/**
 * The composition root. Every service the bot runs on is built here, once, and
 * finalized once.
 *
 * The build order is the dependency order, bottom up:
 *
 *   platform (Bun's filesystem, path, crypto, child processes)
 *     └─ telemetry — logger, the JSONL ledger, the config-gated OTLP forwarder
 *          └─ the chat store, the allow-list, the grammy bot, the board client,
 *             transcription, the sandbox
 *               └─ the notifier
 *                    └─ the manager turn, the stuck watch
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
import { sandboxLayer } from "@workspace/sandbox";
import { EventLog, telemetryLayer } from "@workspace/telemetry";
import { makeTokenSigner, type TokenSigner } from "@workspace/token";
import { type Context, Effect, Layer, Option, Schema } from "effect";
import { SERVICE_NAME } from "./identity";
import { mintManagerToken } from "./manager/token";
import { ManagerTurn } from "./manager/turn";
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
  // Read once, here. Two things mint against it at different times — the board
  // client per tapped button, the manager turn per turn — and two reads of
  // `BETTER_AUTH_SECRET` would be two chances to disagree about the key this
  // deployment signs with.
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
 */
const mintFor =
  (options: { readonly signer: TokenSigner; readonly ttlMs: number }) =>
  (actor: Parameters<MintManagerToken>[0]) =>
    mintManagerToken({
      signer: options.signer,
      threadId: actor.threadId,
      ttlMs: options.ttlMs,
      userId: actor.userId,
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
 * transport, the board, transcription and a sandbox to run a turn in.
 *
 * `sandboxLayer` reads `SANDBOX_MODE` itself and hands back docker or local. The
 * choice is not made here and must not be — the moment this file can ask which
 * implementation it got, the manager turn grows a branch and the escape hatch
 * stops being the same code path.
 */
const infrastructureLayer = (wiring: BotWiring) =>
  Layer.mergeAll(
    Allowlist.layer(wiring.allowlist),
    Board.layer({
      // The gateway as *this process* reaches it, which is not what the
      // container calls it — see `MANAGER_GATEWAY_URL` beside this one.
      baseUrl: wiring.env.botGatewayUrl,
      mint: mintFor({
        signer: wiring.signer,
        ttlMs: wiring.env.managerTokenTtlMs,
      }),
    }),
    BotService.layer(wiring.botToken),
    TranscribeService.layer,
    chatStoreLayer({ applicationName: SERVICE_NAME }),
    sandboxLayer
  ).pipe(Layer.provideMerge(observabilityLayer));

/** A configured origin may or may not end in a slash; the link may not have two. */
const TRAILING_SLASHES = /\/+$/;

/** Where a person clicks to see a task, or nothing when this deployment has no public origin. */
const taskUrlFor = (origin: Option.Option<string>) => (taskId: TaskId) =>
  Option.match(origin, {
    onNone: () => null,
    onSome: (base) => `${base.replace(TRAILING_SLASHES, "")}/tasks/${taskId}`,
  });

/**
 * The whole process, as one layer.
 *
 * Provide it to the entrypoint and nothing else: a second build would mean a
 * second connection pool, a second ledger handle and a second poller all
 * claiming to be this bot. Everything is merged out rather than hidden, because
 * the entrypoint legitimately reaches most of it — it registers the handlers on
 * the bot, forks the listener on the pool's own `PgClient`, and starts the scan.
 *
 * `managerTurn` is the one substitution this file allows, and it exists for
 * `bun run bot:check`: everything else in the process can be exercised without a
 * network, but a real manager turn is a container and a model call. Production
 * passes nothing and gets the real one.
 */
export const appLayer = (
  wiring: BotWiring,
  managerTurn: ReturnType<typeof ManagerTurn.layer> = ManagerTurn.layer(
    wiring.env
  )
) =>
  Layer.mergeAll(
    managerTurn,
    StuckScan.layer.pipe(Layer.provide(stuckAnnouncerLayer))
  ).pipe(
    Layer.provideMerge(
      Notifier.layer({
        retryGraceMs: wiring.env.notifyRetryGraceMs,
        splitAt: wiring.env.botSplitAt,
        taskUrl: taskUrlFor(wiring.env.gatewayPublicUrl),
      })
    ),
    Layer.provideMerge(infrastructureLayer(wiring))
  );
