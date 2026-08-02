/**
 * The one line an operator reads to find out what the process thinks it is.
 *
 * Every knob that changes the loop's behaviour is on it, because the failure
 * this prevents is the expensive kind of confusion: a loop running the local
 * sandbox on a box the operator believes is containerized, or a two-slot pool
 * on a host provisioned for four. Config that is only in the environment is
 * config nobody checks.
 *
 * Nothing on the banner is a credential. `DATABASE_URL` and
 * `OTEL_EXPORTER_OTLP_HEADERS` carry secrets and are never read here — the OTLP
 * export is reported as on or off, which is the only part of it an operator has
 * to be able to see, and the endpoint itself stays out because some collectors
 * carry a token in the URL.
 */

import type { OrchestratorConfig } from "@workspace/orchestrator";
import { EventLog } from "@workspace/telemetry";
import { Config, Effect, Option } from "effect";
import { LOOP_INSTANCE, SERVICE_NAME } from "./identity";

/**
 * Whether the additive OTLP sink has an endpoint to ship to.
 *
 * Read here rather than taken from `@workspace/telemetry`, and only ever as a
 * boolean: this is a report on a decision that package makes, not a second
 * place the decision is made. If the two ever disagree the ledger is still the
 * record — it is always on.
 */
export const otlpConfigured = Effect.map(
  Config.option(Config.string("OTEL_EXPORTER_OTLP_ENDPOINT")),
  Option.isSome
);

/** Everything the banner reports that is not read from the environment by the banner itself. */
export interface BannerInput {
  readonly config: OrchestratorConfig;
  readonly instance: string;
  /** Path of the JSONL ledger `bun run logs` reads. */
  readonly ledgerPath: string;
  readonly otlp: boolean;
  readonly shutdownGraceMs: number;
}

/**
 * The banner's fields, as data.
 *
 * Pure and separate from the emit so the invariant that matters can be tested:
 * every resolved setting appears here. A knob added to `orchestratorConfig` and
 * forgotten here is a knob an operator cannot see, and the test fails until it
 * is added.
 */
export const bannerFields = (input: BannerInput) => ({
  /** One per provider, and the one thing an operator has to create by hand. */
  agentHomes: input.config.agentHomeDirs,
  agentTokenTtlMs: input.config.agentTokenTtlMs,
  chatConcurrency: input.config.maxChatConcurrency,
  chatTimeoutMs: input.config.chatTimeoutMs,
  concurrency: input.config.maxConcurrency,
  dataRoot: input.config.dataRoot,
  /** Null on an install that gave its agents no board tools, which is legal. */
  gateway: input.config.gatewayUrl,
  instance: input.instance,
  leaseHeartbeatMs: input.config.leaseHeartbeatMs,
  leaseStaleMs: input.config.leaseStaleMs,
  ledger: input.ledgerPath,
  maxAttempts: input.config.maxAttempts,
  otlp: input.otlp ? "on" : "off",
  parkMs: input.config.parkMs,
  pollIntervalMs: input.config.pollIntervalMs,
  provider: input.config.defaultProvider,
  retryBaseMs: input.config.retryBaseMs,
  retryMaxMs: input.config.retryMaxMs,
  runTimeoutMs: input.config.runTimeoutMs,
  sandbox: input.config.sandboxKind,
  service: SERVICE_NAME,
  shutdownGraceMs: input.shutdownGraceMs,
});

/** What the banner's message says, before the fields are annotated onto it. */
const headline = (config: OrchestratorConfig) =>
  `loop starting — ${config.sandboxKind} sandbox, ${config.maxConcurrency} work slots and ${config.maxChatConcurrency} chat slots, default provider ${config.defaultProvider}`;

/**
 * Emits the banner, and — only when the sandbox is not isolating anything — the
 * warning that goes with it.
 *
 * The mode is on the banner either way; the second line exists because `local`
 * is the one resolved setting that is dangerous rather than merely surprising,
 * and a warning is what still reaches an operator who has quieted the service
 * to `Warn`.
 */
export const logBanner = (input: {
  readonly config: OrchestratorConfig;
  readonly shutdownGraceMs: number;
}) =>
  Effect.gen(function* () {
    const ledger = yield* EventLog;
    const otlp = yield* otlpConfigured;
    const fields = bannerFields({
      config: input.config,
      instance: LOOP_INSTANCE,
      ledgerPath: ledger.path,
      otlp,
      shutdownGraceMs: input.shutdownGraceMs,
    });
    yield* Effect.logInfo(headline(input.config)).pipe(
      Effect.annotateLogs(fields)
    );
    if (input.config.sandboxKind === "local") {
      yield* Effect.logWarning(
        "sandbox mode is local: runs execute as host processes with no container isolation"
      );
    }
  });
