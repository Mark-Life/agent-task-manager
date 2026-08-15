import { Config, Context, Effect, Layer, Option } from "effect";

/** Mirrors the default `@workspace/db` applies to `DATABASE_POOL_MAX`. */
const DEFAULT_DATABASE_POOL_MAX = 10;

/** Mirrors the default `@workspace/db` applies to `DATABASE_CONNECT_TIMEOUT_MS`. */
const DEFAULT_DATABASE_CONNECT_TIMEOUT_MS = 10_000;

// Mirrors the defaults `apps/bot` applies to its own Config reads. The bot is
// the only reader; these are here so one file lists the whole contract.
const DEFAULT_BOT_SHUTDOWN_GRACE_MS = 15_000;
const DEFAULT_BOT_SPLIT_AT = 4000;
const DEFAULT_BOT_ANNOUNCE_RESTART = true;
const DEFAULT_BOT_ANNOUNCE_QUIET_MS = 900_000;
const DEFAULT_BOT_GATEWAY_URL = "http://localhost:3100";
/** Mirrors the default `apps/gateway` applies to `GATEWAY_SAMPLE_ONE_IN`. */
const DEFAULT_GATEWAY_SAMPLE_ONE_IN = 20;
const DEFAULT_NOTIFY_REPAIR_INTERVAL_MS = 60_000;
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
 *
 * The auth variables are the same kind of entry. `BETTER_AUTH_URL` is read by
 * the library itself, and `DASHBOARD_ORIGIN` and `AUTH_COOKIE_DOMAIN` are read
 * from `process.env` where the auth options are built, because that object is
 * assembled at import time with no runtime around it. They are listed here so
 * one file still says what the environment has to carry.
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
  // sends its board write. Not the same address a container resolves under
  // `SANDBOX_MODE=docker`, which is why the loop reads its own.
  const botGatewayUrl = yield* Config.string("BOT_GATEWAY_URL").pipe(
    Config.withDefault(DEFAULT_BOT_GATEWAY_URL)
  );

  // Where a task lives for a person to click. Optional: with no public origin a
  // notification carries the task's title and no link, rather than a link to
  // localhost that only works on the server.
  const gatewayPublicUrl = yield* Config.option(
    Config.string("GATEWAY_PUBLIC_URL")
  );

  // How much of its own `atm.request` traffic the gateway stores: one row in
  // this many, once the failures, the streams and the requests above a route's
  // p99 have been kept whole. `1` keeps everything. Mirrors the default the
  // gateway applies to its own Config read — see
  // `apps/gateway/src/request-sampling.ts` for what the figure buys.
  const gatewaySampleOneIn = yield* Config.int("GATEWAY_SAMPLE_ONE_IN").pipe(
    Config.withDefault(DEFAULT_GATEWAY_SAMPLE_ONE_IN)
  );

  // The dashboard's origin — scheme and host, no path, no trailing slash. Two
  // readers, one value: the gateway trusts it as an origin the browser may post
  // from, and the bot builds the link on a notification out of it. The gateway
  // serves no static assets, so a task link pointed at its origin is a 404
  // wherever the two are not the same host.
  //
  // A comma-separated list widens the first reader without touching the second:
  // every entry is an origin the browser may post from, and the first is the
  // one a link is built from, since a notification has to name a single address.
  const dashboardOrigin = (yield* Config.option(
    Config.string("DASHBOARD_ORIGIN")
  )).pipe(
    Option.map((value) => value.split(",")[0]?.trim() ?? ""),
    Option.filter((value) => value !== "")
  );

  // The registrable domain the dashboard and the gateway share, leading dot
  // included, e.g. `.example.com`. It widens the session cookie so the two
  // hosts are the same site to a browser. Unset means the cookie stays on the
  // gateway's own host, which is right for a local run and for anything served
  // from one origin.
  const authCookieDomain = yield* Config.option(
    Config.string("AUTH_COOKIE_DOMAIN")
  );

  // The origin the auth library builds cookie and callback URLs from — the
  // gateway's public one. Better Auth reads it from the environment itself; it
  // is named here because it is required whenever the cookie domain above is
  // set, and a boot that fails on that says so about a variable no typed
  // config mentioned.
  const betterAuthUrl = yield* Config.option(Config.string("BETTER_AUTH_URL"));

  // The password the bootstrap gives the seeded owner. Read only by the seed,
  // which links a credential account with it; unset means the owner exists and
  // cannot sign in, which is a fine state for a database nobody logs into.
  const ownerPassword = yield* Config.option(Config.redacted("OWNER_PASSWORD"));

  // Bot process and renderer knobs.
  const botShutdownGraceMs = yield* Config.int("BOT_SHUTDOWN_GRACE_MS").pipe(
    Config.withDefault(DEFAULT_BOT_SHUTDOWN_GRACE_MS)
  );
  const botSplitAt = yield* Config.int("BOT_SPLIT_AT").pipe(
    Config.withDefault(DEFAULT_BOT_SPLIT_AT)
  );

  // Whether the bot says anything about its own restarts. On by default: an
  // unexplained silence is the failure this exists to fix, and a deployment
  // that would rather have quiet chats can say so.
  const botAnnounceRestart = yield* Config.boolean("BOT_ANNOUNCE_RESTART").pipe(
    Config.withDefault(DEFAULT_BOT_ANNOUNCE_RESTART)
  );

  // How long the bot stays quiet about itself after saying something. This is
  // the whole defence against a crash loop or a rolling deploy filling a chat,
  // and it is counted on the notification ledger rather than in the process,
  // because the process is the thing that keeps restarting.
  const botAnnounceQuietMs = yield* Config.int("BOT_ANNOUNCE_QUIET_MS").pipe(
    Config.withDefault(DEFAULT_BOT_ANNOUNCE_QUIET_MS)
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
  // Read here as documentation of the contract only: `@workspace/harness` reads
  // the same variable itself where the provider registry is built, because the
  // process that applies it is the one inside the container.
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
    authCookieDomain,
    betterAuthUrl,
    botAnnounceQuietMs,
    botAnnounceRestart,
    botGatewayUrl,
    botShutdownGraceMs,
    botSplitAt,
    claudeSettingsJson,
    dashboardOrigin,
    databaseConnectTimeoutMs,
    databasePoolMax,
    databaseUrl,
    dataRoot,
    eventLogDir,
    executorMcpKey,
    executorMcpUrl,
    gatewayPublicUrl,
    gatewaySampleOneIn,
    gitSha,
    groqApiKey,
    logFormat,
    logLevel,
    notifyRepairIntervalMs,
    notifyRetryGraceMs,
    otlpEndpoint,
    otlpHeaders,
    ownerPassword,
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
