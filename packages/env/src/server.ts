import { Config, Context, Effect, Layer } from "effect";

/** Mirrors the default `@workspace/db` applies to `DATABASE_POOL_MAX`. */
const DEFAULT_DATABASE_POOL_MAX = 10;

/** Mirrors the default `@workspace/db` applies to `DATABASE_CONNECT_TIMEOUT_MS`. */
const DEFAULT_DATABASE_CONNECT_TIMEOUT_MS = 10_000;

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
    claudeSettingsJson,
    databaseConnectTimeoutMs,
    databasePoolMax,
    databaseUrl,
    dataRoot,
    eventLogDir,
    executorMcpKey,
    executorMcpUrl,
    gitSha,
    logFormat,
    logLevel,
    otlpEndpoint,
    otlpHeaders,
    serviceVersion,
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
