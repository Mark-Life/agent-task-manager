/**
 * The one line an operator reads to find out what the process thinks it is.
 *
 * Every knob that changes what the bot does is on it, because the failure this
 * prevents is the expensive kind of confusion: a bot answering an allow-list of
 * one when three people were meant to be on it, a button pointed at a gateway
 * URL this process cannot resolve, or a second process quietly polling the same
 * token. Config that is only in the environment is config nobody checks.
 *
 * Nothing on the banner is a credential. The bot token, `DATABASE_URL`, the Groq
 * key and the OTLP headers are never read here — transcription and the OTLP
 * export are reported as on or off, which is the only part of either an operator
 * has to see.
 */

import { EventLog } from "@workspace/telemetry";
import { Config, Effect, Option } from "effect";
import { BOT_INSTANCE, SERVICE_NAME } from "./identity";
import type { BotEnv } from "./layers";
import { CHAT_PROVIDER } from "./telegram/threads";

/**
 * Whether the additive OTLP sink has an endpoint to ship to.
 *
 * Read here rather than taken from `@workspace/telemetry`, and only ever as a
 * boolean: this is a report on a decision that package makes, not a second place
 * the decision is made.
 */
export const otlpConfigured = Effect.map(
  Config.option(Config.string("OTEL_EXPORTER_OTLP_ENDPOINT")),
  Option.isSome
);

/** Everything the banner reports that it does not read from the environment itself. */
export interface BannerInput {
  /** How many Telegram accounts this process will answer at all. */
  readonly allowedAccounts: number;
  /** How many workspaces those accounts span, which is what the scans iterate. */
  readonly allowedWorkspaces: number;
  readonly env: BotEnv;
  /** Path of the JSONL ledger `bun run logs` reads. */
  readonly ledgerPath: string;
  readonly otlp: boolean;
}

/**
 * The banner's fields, as data.
 *
 * Pure and separate from the emit so the invariant that matters is assertable:
 * every resolved setting appears here. A knob added to the environment and
 * forgotten here is a knob an operator cannot see.
 */
export const bannerFields = (input: BannerInput) => ({
  accounts: input.allowedAccounts,
  announceQuietMs: input.env.botAnnounceQuietMs,
  announceRestart: input.env.botAnnounceRestart ? "on" : "off",
  chatProvider: CHAT_PROVIDER,
  dataRoot: input.env.dataRoot,
  gatewayUrl: input.env.botGatewayUrl,
  instance: BOT_INSTANCE,
  ledger: input.ledgerPath,
  notifyRepairIntervalMs: input.env.notifyRepairIntervalMs,
  notifyRetryGraceMs: input.env.notifyRetryGraceMs,
  otlp: input.otlp ? "on" : "off",
  service: SERVICE_NAME,
  shutdownGraceMs: input.env.botShutdownGraceMs,
  splitAt: input.env.botSplitAt,
  stuckScanIntervalMs: input.env.stuckScanIntervalMs,
  stuckWindowMinutes: input.env.stuckWindowMinutes,
  // On or off, never the key: a banner is the one line that gets pasted into a
  // ticket.
  transcription: Option.isSome(input.env.groqApiKey) ? "on" : "off",
  workspaces: input.allowedWorkspaces,
});

/** What the banner's message says, before the fields are annotated onto it. */
const headline = (input: BannerInput) =>
  `bot starting — ${input.allowedAccounts} allow-listed account(s), conversations answered on ${CHAT_PROVIDER} by the orchestrator`;

/**
 * Emits the banner, and — only where transcription is off — the note that goes
 * with it.
 *
 * A missing Groq key is not a reason to refuse to start: text still works and
 * voice notes are refused with a reply. It is a reason to say so once, because
 * "the bot ignores my voice notes" is otherwise diagnosed from the outside.
 */
export const logBanner = (input: {
  readonly allowedAccounts: number;
  readonly allowedWorkspaces: number;
  readonly env: BotEnv;
}) =>
  Effect.gen(function* () {
    const ledger = yield* EventLog;
    const otlp = yield* otlpConfigured;
    const fields = bannerFields({ ...input, ledgerPath: ledger.path, otlp });
    yield* Effect.logInfo(
      headline({ ...input, ledgerPath: ledger.path, otlp })
    ).pipe(Effect.annotateLogs(fields));
    if (Option.isNone(input.env.groqApiKey)) {
      yield* Effect.logWarning(
        "GROQ_API_KEY is not set: voice notes will be refused with a reply"
      );
    }
  });
