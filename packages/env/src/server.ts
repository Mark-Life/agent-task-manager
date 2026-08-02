import { Config, Context, Effect, Layer } from "effect";

/** Mirrors the default `@workspace/db` applies to `DATABASE_POOL_MAX`. */
const DEFAULT_DATABASE_POOL_MAX = 10;

/** Mirrors the default `@workspace/db` applies to `DATABASE_CONNECT_TIMEOUT_MS`. */
const DEFAULT_DATABASE_CONNECT_TIMEOUT_MS = 10_000;

// Mirrors the defaults `apps/bot` applies to its own Config reads. The bot is
// the only reader; these are here so one file lists the whole contract.
const DEFAULT_BOT_SHUTDOWN_GRACE_MS = 15_000;
const DEFAULT_BOT_DRAFT_INTERVAL_MS = 300;
const DEFAULT_BOT_SPLIT_AT = 4000;
const DEFAULT_BOT_GATEWAY_URL = "http://localhost:3100";
const DEFAULT_MANAGER_GATEWAY_URL = "http://localhost:3100";
const DEFAULT_NOTIFY_REPAIR_INTERVAL_MS = 60_000;
const DEFAULT_MANAGER_PROVIDER = "claude" as const;
const DEFAULT_MANAGER_TURN_TIMEOUT_MS = 300_000;
const DEFAULT_MANAGER_TOKEN_TTL_MS = 900_000;
const DEFAULT_MANAGER_HISTORY_MESSAGES = 40;
const DEFAULT_NOTIFY_RETRY_GRACE_MS = 60_000;
const DEFAULT_STUCK_SCAN_INTERVAL_MS = 60_000;
const DEFAULT_STUCK_WINDOW_MINUTES = 10;
const DEFAULT_STUCK_MIN_TOOL_CALLS = 6;
const DEFAULT_STUCK_DISTINCT_SIGNATURES = 2;

/**
 * Reads and validates the Effect-side application configuration from the
 * environment. `DATABASE_URL` is required and fails the layer build when
 * missing, so misconfiguration surfaces at boot. Everything else is optional or
 * defaulted: only the app that needs a given setting (bot, a specific agent
 * provider, Executor, an OTLP collector) fails without it.
 *
 * The telemetry and database variables here are documentation of the contract,
 * not the source of truth — `@workspace/telemetry` reads `LOG_FORMAT`,
 * `LOG_LEVEL`, `EVENT_LOG_DIR`, `OTEL_EXPORTER_OTLP_ENDPOINT`,
 * `OTEL_EXPORTER_OTLP_HEADERS`, `SERVICE_VERSION` and `GIT_SHA` directly via
 * `Config`, and `@workspace/db` reads the `DATABASE_*` set the same way, so a
 * script wanting only a database handle need not build this layer. Names and
 * defaults must stay in sync by hand.
 */
const load = Effect.gen(function* () {
  const databaseUrl = yield* Config.redacted("DATABASE_URL");

  // Connection pool knobs, read by `@workspace/db`. Per process, not per
  // system: several of ours point at the same database at once.
  const databasePoolMax = yield* Config.int("DATABASE_POOL_MAX").pipe(
    Config.withDefault(DEFAULT_DATABASE_POOL_MAX)
  );

  // `pg` waits forever by default, so a database that is down looks like a
  // process that hangs at boot saying nothing.
  const databaseConnectTimeoutMs = yield* Config.int(
    "DATABASE_CONNECT_TIMEOUT_MS"
  ).pipe(Config.withDefault(DEFAULT_DATABASE_CONNECT_TIMEOUT_MS));

  // Same default as `@workspace/telemetry` applies to it. A required DATA_ROOT
  // here would mean telemetry runs with no env at all while any app reading this
  // layer refuses to boot.
  const dataRoot = yield* Config.string("DATA_ROOT").pipe(
    Config.withDefault(".data")
  );

  const telegramBotToken = yield* Config.option(
    Config.redacted("TELEGRAM_BOT_TOKEN")
  );

  // Who the bot answers to: `telegramUserId:workspaceId:userId`, comma
  // separated. Optional here and required by the bot, which refuses to boot on
  // a missing or malformed list rather than silently ignoring someone.
  const telegramAllowlist = yield* Config.option(
    Config.string("TELEGRAM_ALLOWLIST")
  );

  // Voice transcription. Absent means voice notes are refused with a reply and
  // every other kind of message still works.
  const groqApiKey = yield* Config.option(Config.redacted("GROQ_API_KEY"));

  // The gateway as the *bot process* reaches it, which is where a tapped button
  // sends its board write. Deliberately a second variable from the manager's:
  // under `SANDBOX_MODE=docker` the two are different addresses for the same
  // server, and one variable would be wrong for one of the two callers.
  const botGatewayUrl = yield* Config.string("BOT_GATEWAY_URL").pipe(
    Config.withDefault(DEFAULT_BOT_GATEWAY_URL)
  );

  // Where a task lives for a person to click. Optional: with no public origin a
  // notification carries the task's title and no link, rather than a link to
  // localhost that only works on the server.
  const gatewayPublicUrl = yield* Config.option(
    Config.string("GATEWAY_PUBLIC_URL")
  );

  // The manager agent: one container turn per inbound message. The gateway URL
  // is the one *the container* resolves, which is not the host's when the
  // sandbox is docker.
  const managerGatewayUrl = yield* Config.string("MANAGER_GATEWAY_URL").pipe(
    Config.withDefault(DEFAULT_MANAGER_GATEWAY_URL)
  );
  const managerProvider = yield* Config.literals(
    ["claude", "codex"] as const,
    "MANAGER_PROVIDER"
  ).pipe(Config.withDefault(DEFAULT_MANAGER_PROVIDER));
  const managerModel = yield* Config.option(Config.string("MANAGER_MODEL"));
  const managerTurnTimeoutMs = yield* Config.int(
    "MANAGER_TURN_TIMEOUT_MS"
  ).pipe(Config.withDefault(DEFAULT_MANAGER_TURN_TIMEOUT_MS));

  // Short, because nothing can recall a minted token.
  const managerTokenTtlMs = yield* Config.int("MANAGER_TOKEN_TTL_MS").pipe(
    Config.withDefault(DEFAULT_MANAGER_TOKEN_TTL_MS)
  );
  const managerHistoryMessages = yield* Config.int(
    "MANAGER_HISTORY_MESSAGES"
  ).pipe(Config.withDefault(DEFAULT_MANAGER_HISTORY_MESSAGES));

  // Bot process and renderer knobs.
  const botShutdownGraceMs = yield* Config.int("BOT_SHUTDOWN_GRACE_MS").pipe(
    Config.withDefault(DEFAULT_BOT_SHUTDOWN_GRACE_MS)
  );
  const botDraftIntervalMs = yield* Config.int("BOT_DRAFT_INTERVAL_MS").pipe(
    Config.withDefault(DEFAULT_BOT_DRAFT_INTERVAL_MS)
  );
  const botSplitAt = yield* Config.int("BOT_SPLIT_AT").pipe(
    Config.withDefault(DEFAULT_BOT_SPLIT_AT)
  );

  // How long a claimed-but-undelivered notification waits before the repair
  // pass sends it again.
  const notifyRetryGraceMs = yield* Config.int("NOTIFY_RETRY_GRACE_MS").pipe(
    Config.withDefault(DEFAULT_NOTIFY_RETRY_GRACE_MS)
  );

  // How often the repair pass looks for claims nobody delivered. A `NOTIFY`
  // delivered while the listener was reconnecting is lost forever, so the tick
  // beside it is what makes the ledger the record rather than the channel.
  const notifyRepairIntervalMs = yield* Config.int(
    "NOTIFY_REPAIR_INTERVAL_MS"
  ).pipe(Config.withDefault(DEFAULT_NOTIFY_REPAIR_INTERVAL_MS));

  // The stuck-run heuristic's thresholds. Config, never literals in the
  // detection code, so tuning one is not a code change.
  const stuckScanIntervalMs = yield* Config.int("STUCK_SCAN_INTERVAL_MS").pipe(
    Config.withDefault(DEFAULT_STUCK_SCAN_INTERVAL_MS)
  );
  const stuckWindowMinutes = yield* Config.int("STUCK_WINDOW_MINUTES").pipe(
    Config.withDefault(DEFAULT_STUCK_WINDOW_MINUTES)
  );
  const stuckMinToolCalls = yield* Config.int("STUCK_MIN_TOOL_CALLS").pipe(
    Config.withDefault(DEFAULT_STUCK_MIN_TOOL_CALLS)
  );
  const stuckDistinctSignatures = yield* Config.int(
    "STUCK_DISTINCT_SIGNATURES"
  ).pipe(Config.withDefault(DEFAULT_STUCK_DISTINCT_SIGNATURES));

  // Agent provider settings. Claude runs on subscription auth by default;
  // ANTHROPIC_API_KEY is only a fallback for headless/CI use. Codex reads its
  // own CLI login and needs no key here.
  const anthropicApiKey = yield* Config.option(
    Config.redacted("ANTHROPIC_API_KEY")
  );
  const claudeSettingsJson = yield* Config.option(
    Config.string("CLAUDE_SETTINGS_JSON")
  );

  // Executor MCP: both optional, absence means no Executor tools are wired.
  const executorMcpUrl = yield* Config.option(
    Config.string("EXECUTOR_MCP_URL")
  );
  const executorMcpKey = yield* Config.option(
    Config.redacted("EXECUTOR_MCP_KEY")
  );

  // Telemetry set — mirrored here for services that need the resolved value
  // outside the telemetry layer itself (e.g. a startup banner). See the
  // module doc comment: `@workspace/telemetry` re-reads these independently.
  const logFormat = yield* Config.literals(
    ["pretty", "logfmt", "json"] as const,
    "LOG_FORMAT"
  ).pipe(Config.option);

  const logLevel = yield* Config.logLevel("LOG_LEVEL").pipe(
    Config.withDefault("Info" as const)
  );

  const eventLogDir = yield* Config.string("EVENT_LOG_DIR").pipe(
    Config.withDefault(`${dataRoot}/events`)
  );

  const otlpEndpoint = yield* Config.option(
    Config.string("OTEL_EXPORTER_OTLP_ENDPOINT")
  );
  const otlpHeaders = yield* Config.option(
    Config.redacted("OTEL_EXPORTER_OTLP_HEADERS")
  );

  const serviceVersion = yield* Config.option(Config.string("SERVICE_VERSION"));
  const gitSha = yield* Config.option(Config.string("GIT_SHA"));

  return {
    anthropicApiKey,
    botDraftIntervalMs,
    botGatewayUrl,
    botShutdownGraceMs,
    botSplitAt,
    claudeSettingsJson,
    databaseConnectTimeoutMs,
    databasePoolMax,
    databaseUrl,
    dataRoot,
    eventLogDir,
    executorMcpKey,
    executorMcpUrl,
    gatewayPublicUrl,
    gitSha,
    groqApiKey,
    logFormat,
    logLevel,
    managerGatewayUrl,
    managerHistoryMessages,
    managerModel,
    managerProvider,
    managerTokenTtlMs,
    managerTurnTimeoutMs,
    notifyRepairIntervalMs,
    notifyRetryGraceMs,
    otlpEndpoint,
    otlpHeaders,
    serviceVersion,
    stuckDistinctSignatures,
    stuckMinToolCalls,
    stuckScanIntervalMs,
    stuckWindowMinutes,
    telegramAllowlist,
    telegramBotToken,
  } as const;
});

/**
 * `ServerEnv` service: validated, typed, redacted configuration for the
 * Effect-side services (`db`, `harness`, `sandbox`, `orchestrator`, the
 * gateway, the loop, the bot). Provide `ServerEnv.layer` at each app's
 * composition root; yield `ServerEnv` downstream to read resolved values.
 */
export class ServerEnv extends Context.Service<
  ServerEnv,
  Effect.Success<typeof load>
>()("@workspace/env/ServerEnv") {
  static readonly layer = Layer.effect(ServerEnv, load);
}
