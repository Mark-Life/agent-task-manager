/**
 * The bot's entrypoint: composition, startup order, and lifetime. Nothing else.
 *
 * Startup is a sequence and the order is load-bearing. The environment is read
 * first, before a single layer is built, so a missing token or a malformed
 * allow-list is one sentence at boot rather than a stack trace out of a layer
 * that half succeeded. The watchdog is armed next — before the pool connects and
 * before the poller starts — so a process that wedges while building its layers,
 * on a database that is down or a docker daemon that is not there, is still one
 * a signal can stop. Only then does the banner go out and the bot start taking
 * updates.
 *
 * Shutdown is the same property read backwards, and it belongs to the runtime
 * and the scope: see `./shutdown`.
 */

import { BunRuntime } from "@effect/platform-bun";
import { sandboxKindConfig } from "@workspace/sandbox";
import { Effect } from "effect";
import { logBanner } from "./banner";
import { runBot } from "./index";
import { appLayer, type BotWiring, botWiring } from "./layers";
import { armShutdownWatchdog } from "./shutdown";
import { Allowlist } from "./telegram/allowlist";

/**
 * Boot, announce, then answer until interrupted.
 *
 * The sandbox mode is read here rather than taken from the layer, and only as a
 * label: this is a report on a decision `sandboxLayer` makes, not a second place
 * it is made.
 */
const program = (wiring: BotWiring) =>
  Effect.gen(function* () {
    const allowlist = yield* Allowlist;
    const sandboxKind = yield* sandboxKindConfig;
    yield* logBanner({
      allowedAccounts: allowlist.telegramUserIds.length,
      allowedWorkspaces: allowlist.workspaceIds.length,
      env: wiring.env,
      sandboxKind,
    });
    yield* runBot(wiring);
  }).pipe(Effect.scoped);

if (import.meta.main) {
  BunRuntime.runMain(
    botWiring.pipe(
      Effect.tap((wiring) =>
        armShutdownWatchdog(wiring.env.botShutdownGraceMs)
      ),
      Effect.flatMap((wiring) =>
        program(wiring).pipe(Effect.provide(appLayer(wiring)))
      )
    )
  );
}
