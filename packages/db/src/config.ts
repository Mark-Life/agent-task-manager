import { Config, Effect } from "effect";

/**
 * Connections one process may hold open. The database runs in a container on a
 * four-core box shared with the agent containers, and several of our processes
 * (gateway, loop, a seed script) point at it at once, so the ceiling here is
 * per process and not the whole system's budget. Ten is generous for a board
 * and an orchestrator; raise it only after `pg_stat_activity` says the pool is
 * the queue.
 */
const DEFAULT_POOL_MAX = 10;

/**
 * How long a checkout waits for a free connection before failing. `pg` defaults
 * to waiting forever, which turns a database that is down into a process that
 * hangs at boot with no error — the one failure mode that looks like nothing is
 * wrong.
 */
const DEFAULT_CONNECT_TIMEOUT_MILLIS = 10_000;

/**
 * Everything needed to reach Postgres, read from the environment.
 *
 * Read through `Config` rather than through `@workspace/env` on purpose: this
 * package is imported by the gateway, the loop and by one-off scripts, and a
 * script that only wants a database handle should not have to build the whole
 * application environment first. `@workspace/env` declares the same variables
 * for documentation; the names and defaults are kept in sync by hand, exactly
 * as they are for `@workspace/telemetry`.
 */
export const databaseConfig = Effect.gen(function* () {
  const url = yield* Config.redacted("DATABASE_URL");

  const poolMax = yield* Config.int("DATABASE_POOL_MAX").pipe(
    Config.withDefault(DEFAULT_POOL_MAX)
  );

  const connectTimeoutMillis = yield* Config.int(
    "DATABASE_CONNECT_TIMEOUT_MS"
  ).pipe(Config.withDefault(DEFAULT_CONNECT_TIMEOUT_MILLIS));

  return { connectTimeoutMillis, poolMax, url } as const;
});

/** The resolved database settings, as {@link databaseConfig} produces them. */
export interface DatabaseConfig extends Effect.Success<typeof databaseConfig> {}
