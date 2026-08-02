/**
 * Every knob the loop has, read from the environment in one place.
 *
 * Read through `Config` rather than through `@workspace/env`, for the same
 * reason `@workspace/db` does: a check script that wants to know the
 * concurrency cap should not have to build the whole application environment
 * first, and a test overrides one value with a `ConfigProvider` instead of a
 * process-wide `process.env` write. The names follow the convention
 * `packages/env/src/server.ts` documents — the area, then the thing, then the
 * unit — and the two are kept in sync by hand.
 *
 * Two settings are deliberately not redeclared here. `SANDBOX_MODE` is read
 * through `@workspace/sandbox`'s own config, because a second spelling of it is
 * a loop that reports `docker` on its rows while running the local
 * implementation. `DATA_ROOT` keeps the name and the default the rest of the
 * system already uses, since the run directories this loop creates are the ones
 * the harness and the sandbox read back.
 */

import { SESSION_PROVIDERS, SessionProvider } from "@workspace/domain";
import {
  AGENT_HOME_DIR_ENV_VAR,
  defaultAgentHomeDirOf,
} from "@workspace/harness";
import { sandboxKindConfig } from "@workspace/sandbox";
import { Config, Effect } from "effect";

/**
 * How many runs may hold a container at once.
 *
 * Two, and the host is why. Four cores and 8 GB, shared with Postgres, the
 * gateway and whatever the operator is doing; one coding container is an agent
 * CLI plus a node/bun toolchain plus a checkout, which sits around 1.5–2 GB
 * resident and will take a whole core whenever the model is not the thing being
 * waited on. Three of those leaves the database competing for memory with the
 * agents, and the browser image adds a Chromium on top. Two runs and a core of
 * headroom is the shape that fits.
 *
 * It is a global cap rather than a per-kind one because the constraint is the
 * box, not the work: a trip-planning run and a feature run cost the same
 * container.
 */
const DEFAULT_MAX_CONCURRENCY = 2;

/**
 * How many chat turns may hold a container at once, on top of the work lane.
 *
 * One. A person has one conversation in flight, and a second chat container
 * buys latency nobody is waiting on. It is a lane of its own rather than a
 * share of the work cap because the failure it exists to prevent is a chat
 * starved behind two hour-long worker runs, and a reservation only guarantees
 * that when the reserved count is a separate count.
 *
 * The box's cap is the sum: three containers of four cores, stated as one
 * number in two parts.
 */
const DEFAULT_MAX_CHAT_CONCURRENCY = 1;

/**
 * How often the dispatcher looks for work regardless of notifications.
 *
 * Slow on purpose. `LISTEN/NOTIFY` is what makes a task move the instant it
 * lands in *in progress*; this is the safety net for the one failure that
 * silence looks identical to — a connection dropped between the `LISTEN` and
 * the insert, so the notification was delivered to nobody. Half a minute of
 * added latency on that path is invisible next to a container start, and a
 * faster poll would just be a query per second forever.
 */
const DEFAULT_POLL_INTERVAL_MS = 30_000;

/** How often a held lease is stamped, so another loop can see it is alive. */
const DEFAULT_LEASE_HEARTBEAT_MS = 30_000;

/**
 * How old a lease may be before it is treated as a crash. Three heartbeats: one
 * missed beat is a loop that was busy, three is a loop that is gone, and
 * reclaiming a live run's lease would put two containers on one artifacts
 * directory.
 */
const DEFAULT_LEASE_STALE_MS = 90_000;

/** The first retry delay. Doubles per attempt up to {@link DEFAULT_RETRY_MAX_MS}. */
const DEFAULT_RETRY_BASE_MS = 60_000;

/** The backoff ceiling, so a task that always fails settles at one attempt per half hour. */
const DEFAULT_RETRY_MAX_MS = 1_800_000;

/**
 * How many attempts a task gets before it is parked. Five doublings from a
 * minute is a bit over an hour of trying, which is long enough to ride out a
 * provider outage and short enough that a genuinely broken task is visibly
 * stuck rather than quietly looping.
 */
const DEFAULT_MAX_ATTEMPTS = 5;

/**
 * How long a parked task stays parked. A day, because parking means "a human
 * needs to look at this" and the un-park is a human move into *in progress*;
 * the expiry only exists so a task cannot be parked forever by a transient
 * outage nobody noticed.
 */
const DEFAULT_PARK_MS = 86_400_000;

/**
 * The wall-clock cap on one run. An hour is longer than any turn we have seen
 * and far shorter than forever, which is what a run with no cap holds its slot
 * for — on a two-slot pool, one wedged container is half the factory.
 */
const DEFAULT_RUN_TIMEOUT_MS = 3_600_000;

/**
 * The wall-clock cap on one chat turn. Ten minutes: a person is waiting on it,
 * and a conversation that has been silent that long has already failed as a
 * conversation whatever the model is still doing.
 */
const DEFAULT_CHAT_TIMEOUT_MS = 600_000;

/**
 * How long a turn's board credential lives. Fifteen minutes — a turn is seconds
 * to minutes, nothing can recall a token, and the defence is that it expires
 * before it is worth stealing.
 */
const DEFAULT_AGENT_TOKEN_TTL_MS = 900_000;

/** The provider a task takes when neither it nor a resumed session names one. */
const DEFAULT_PROVIDER: SessionProvider = "claude";

/** Mirrors the default `@workspace/telemetry` and `@workspace/env` apply to `DATA_ROOT`. */
const DEFAULT_DATA_ROOT = ".data";

/**
 * The loop's settings, resolved from the environment.
 *
 * Everything is defaulted: an orchestrator that refuses to boot because nobody
 * set a poll interval is a worse failure than one that polls every thirty
 * seconds. The one setting with real consequences — whether runs are isolated —
 * defaults to isolation, and that decision lives in `@workspace/sandbox`.
 */
export const orchestratorConfig = Effect.gen(function* () {
  const maxConcurrency = yield* Config.int("ORCHESTRATOR_MAX_CONCURRENCY").pipe(
    Config.withDefault(DEFAULT_MAX_CONCURRENCY)
  );

  const pollIntervalMs = yield* Config.int(
    "ORCHESTRATOR_POLL_INTERVAL_MS"
  ).pipe(Config.withDefault(DEFAULT_POLL_INTERVAL_MS));

  const leaseHeartbeatMs = yield* Config.int(
    "ORCHESTRATOR_LEASE_HEARTBEAT_MS"
  ).pipe(Config.withDefault(DEFAULT_LEASE_HEARTBEAT_MS));

  const leaseStaleMs = yield* Config.int("ORCHESTRATOR_LEASE_STALE_MS").pipe(
    Config.withDefault(DEFAULT_LEASE_STALE_MS)
  );

  const retryBaseMs = yield* Config.int("ORCHESTRATOR_RETRY_BASE_MS").pipe(
    Config.withDefault(DEFAULT_RETRY_BASE_MS)
  );

  const retryMaxMs = yield* Config.int("ORCHESTRATOR_RETRY_MAX_MS").pipe(
    Config.withDefault(DEFAULT_RETRY_MAX_MS)
  );

  const maxAttempts = yield* Config.int("ORCHESTRATOR_MAX_ATTEMPTS").pipe(
    Config.withDefault(DEFAULT_MAX_ATTEMPTS)
  );

  const parkMs = yield* Config.int("ORCHESTRATOR_PARK_MS").pipe(
    Config.withDefault(DEFAULT_PARK_MS)
  );

  const runTimeoutMs = yield* Config.int("ORCHESTRATOR_RUN_TIMEOUT_MS").pipe(
    Config.withDefault(DEFAULT_RUN_TIMEOUT_MS)
  );

  const maxChatConcurrency = yield* Config.int(
    "ORCHESTRATOR_MAX_CHAT_CONCURRENCY"
  ).pipe(Config.withDefault(DEFAULT_MAX_CHAT_CONCURRENCY));

  const chatTimeoutMs = yield* Config.int("ORCHESTRATOR_CHAT_TIMEOUT_MS").pipe(
    Config.withDefault(DEFAULT_CHAT_TIMEOUT_MS)
  );

  const agentTokenTtlMs = yield* Config.int(
    "ORCHESTRATOR_AGENT_TOKEN_TTL_MS"
  ).pipe(Config.withDefault(DEFAULT_AGENT_TOKEN_TTL_MS));

  // The gateway as a **container** sees it, which is rarely `localhost`. Absent
  // is a legal install: every turn then runs with no board tools, which the
  // banner says once at boot rather than every run discovering it.
  const gatewayUrl = yield* Config.string("ORCHESTRATOR_GATEWAY_URL").pipe(
    Config.withDefault(null)
  );

  // One system-owned login directory per provider, mounted read-write into
  // every container and never copied. Read here and nowhere else, so the two
  // spellings a vendor uses stay in `@workspace/harness`.
  const agentHomeDirs = Object.fromEntries(
    yield* Effect.forEach(SESSION_PROVIDERS, (provider) =>
      Config.string(AGENT_HOME_DIR_ENV_VAR[provider]).pipe(
        Config.withDefault(defaultAgentHomeDirOf(provider)),
        Effect.map((dir) => [provider, dir] as const)
      )
    )
  ) as Record<SessionProvider, string>;

  // Decoded through the domain's own union, so a typo is a startup failure
  // naming the legal values rather than a dispatch that picks a harness nobody
  // asked for.
  const defaultProvider = yield* Config.schema(
    SessionProvider,
    "ORCHESTRATOR_DEFAULT_PROVIDER"
  ).pipe(Config.withDefault(DEFAULT_PROVIDER));

  const dataRoot = yield* Config.string("DATA_ROOT").pipe(
    Config.withDefault(DEFAULT_DATA_ROOT)
  );

  const sandboxKind = yield* sandboxKindConfig;

  return {
    agentHomeDirs,
    agentTokenTtlMs,
    chatTimeoutMs,
    dataRoot,
    defaultProvider,
    gatewayUrl,
    leaseHeartbeatMs,
    leaseStaleMs,
    maxAttempts,
    maxChatConcurrency,
    maxConcurrency,
    parkMs,
    pollIntervalMs,
    retryBaseMs,
    retryMaxMs,
    runTimeoutMs,
    sandboxKind,
  } as const;
});

/** The resolved loop settings, as {@link orchestratorConfig} produces them. */
export interface OrchestratorConfig
  extends Effect.Success<typeof orchestratorConfig> {}

/** The backoff knobs on their own, which is all {@link retryDelayMs} reads. */
export type RetryPolicy = Pick<
  OrchestratorConfig,
  "maxAttempts" | "retryBaseMs" | "retryMaxMs"
>;

/** How long to wait after `attempt` failed attempts, and whether to bother. */
export interface RetryRequest {
  /** 1-based: the number of the attempt that just failed. */
  readonly attempt: number;
  readonly policy: RetryPolicy;
}

/**
 * The delay before the next attempt, doubling from the base and clamped to the
 * ceiling.
 *
 * A pure function of the attempt number rather than an Effect `Schedule`,
 * because the wait outlives the process that decided on it: the delay is
 * stamped on the task as `parkedUntil` and the next dispatch reads it back, so
 * a loop that restarts mid-backoff resumes the ladder instead of starting it
 * again. A `Schedule` would keep that state in a fiber, which is exactly the
 * place a crash loses it.
 */
export const retryDelayMs = ({ attempt, policy }: RetryRequest) => {
  const steps = Math.max(0, attempt - 1);
  return Math.min(policy.retryMaxMs, policy.retryBaseMs * 2 ** steps);
};

/**
 * Whether the attempt that just failed was the last one. Parking is what stops
 * a broken task from spending every slot on the box forever; any human move
 * back into *in progress* clears it.
 */
export const shouldPark = ({ attempt, policy }: RetryRequest) =>
  attempt >= policy.maxAttempts;
