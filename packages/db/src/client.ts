/**
 * One connection pool, two drizzle handles over it.
 *
 * Two libraries need to reach this database and they want different shapes.
 * Our own code is Effect, so its queries are yielded and its failures are typed
 * values. Better Auth is an ordinary promise library: it was handed a drizzle
 * handle at construction and calls `await` on it, and there is no version of it
 * that speaks Effect. Building a second pool for it would mean two connection
 * budgets, two sets of idle connections against a database that counts them,
 * and — the part that actually hurts — a write made by Better Auth sitting in a
 * transaction on a connection our code cannot join.
 *
 * So the pool is the shared thing and the handles are thin wrappers over it:
 * `PgClient.fromPool` takes the pool we already own rather than opening one
 * (`PgClient.make` and `PgClient.layer` both open their own — never use them
 * here), and `drizzle({ client: pool })` from `drizzle-orm/node-postgres` wraps
 * the very same object. Both are given the same `relations`, so a query written
 * against one reads the same shape as a query written against the other.
 *
 * The pool is owned by a scoped layer: it is closed when the scope closes and
 * at no other point. Nothing in this module opens a connection eagerly — `pg`
 * connects on first checkout, so a wrong `DATABASE_URL` surfaces on the first
 * query rather than at layer build.
 */

import { PgClient } from "@effect/sql-pg";
import * as PgDrizzle from "drizzle-orm/effect-postgres";
import { drizzle } from "drizzle-orm/node-postgres";
import { Context, Effect, Layer, Redacted } from "effect";
import { Pool } from "pg";
import { makeAuth } from "./auth/options";
import { databaseConfig } from "./config";
import { relations } from "./schema";

/** What a process must say about itself to get a database handle. */
export interface DatabaseOptions {
  /**
   * Reported as `application_name` on every connection, so
   * `pg_stat_activity` names the process behind a slow or blocking query.
   * Use the service name — `gateway`, `loop`, `seed`.
   */
  readonly applicationName: string;
}

const acquirePool = (options: DatabaseOptions) =>
  Effect.gen(function* () {
    const config = yield* databaseConfig;

    return yield* Effect.acquireRelease(
      Effect.sync(() => {
        const pool = new Pool({
          // `PgClient.fromPool` reads the name off the pool it is handed and
          // ignores its own `applicationName` option, so this is the only
          // place setting it has any effect.
          application_name: options.applicationName,
          connectionString: Redacted.value(config.url),
          connectionTimeoutMillis: config.connectTimeoutMillis,
          max: config.poolMax,
        });

        // An idle connection dropped by the server emits `error` on the pool,
        // and an unhandled `error` event on an emitter takes the process down.
        // `pg` discards the broken connection and opens a fresh one on the next
        // checkout, and a query that was in flight fails on its own path with
        // its own error, so there is nothing to do here but stay alive.
        pool.on("error", () => {
          // intentionally empty
        });

        return pool;
      }),
      // Shutdown must not fail: a pool that refuses to drain is not a reason to
      // exit non-zero after the work is already done.
      (pool) => Effect.ignore(Effect.promise(() => pool.end()))
    );
  });

/**
 * The pool itself, as a service, because both handles have to be built over the
 * same instance and a layer is what guarantees they are. Depend on this only to
 * build a handle; run queries through {@link Database}.
 */
export class DatabasePool extends Context.Service<DatabasePool, Pool>()(
  "@workspace/db/DatabasePool"
) {
  static readonly layer = (options: DatabaseOptions) =>
    Layer.effect(DatabasePool, acquirePool(options));
}

/**
 * `PgClient` over the shared pool. It is what `PgDrizzle` compiles queries
 * through, and it also carries `listen` / `notify`, which the gateway's event
 * stream and the orchestrator's dispatch trigger ride on. `listen` takes a
 * dedicated connection outside the pool, which is what that channel needs.
 */
const pgClientLayer = PgClient.layerFrom(
  Effect.gen(function* () {
    const pool = yield* DatabasePool;
    return yield* PgClient.fromPool({ acquire: Effect.succeed(pool) });
  })
);

const makeDatabase = PgDrizzle.makeWithDefaults({ relations });

/**
 * The handle every repository writes against. Query builders are yielded, not
 * awaited, and `db.transaction((tx) => ...)` returns an `Effect` — which is
 * what lets a mutation and its audit row commit or fail as one unit.
 */
export class Database extends Context.Service<
  Database,
  Effect.Success<typeof makeDatabase>
>()("@workspace/db/Database") {
  static readonly layer = Layer.effect(Database, makeDatabase);
}

/**
 * The promise-based drizzle handle Better Auth is constructed with, over the
 * pool we already own. It stays inside this module, and inside {@link Auth}: it
 * is built from the whole `relations` object, so it can read and write all
 * sixteen tables, not the seven the auth library manages — a caller holding it
 * would have an actorless, unaudited way into `task` and `run` one import away
 * from every repository in this package.
 */
const makeAuthDatabase = (pool: Pool) => drizzle({ client: pool, relations });

/**
 * The auth instance itself, built over the shared pool.
 *
 * The handle underneath is deliberately not the thing on offer: a server mounts
 * a handler and calls `auth.api`, which is all anyone actually needs, and the
 * one guarantee this package rests on — a mutation writes the audit row naming
 * who made it — survives only while the drizzle handle has nowhere to leak to.
 */
export class Auth extends Context.Service<Auth, ReturnType<typeof makeAuth>>()(
  "@workspace/db/Auth"
) {
  static readonly layer = Layer.effect(
    Auth,
    Effect.map(DatabasePool, (pool) => makeAuth(makeAuthDatabase(pool)))
  );
}

/**
 * Everything this package provides, over exactly one pool. Provide it once at a
 * process's composition root: the pool layer is named once here, so both
 * handles and the `PgClient` resolve to the same instance.
 *
 * `PgClient` and `SqlClient` stay exposed because the listener and any raw SQL
 * a migration-adjacent script needs are legitimate consumers; the pool itself
 * stays hidden, since a caller holding it could open a connection outside every
 * transaction this package manages.
 */
export const databaseLayer = (options: DatabaseOptions) =>
  Layer.mergeAll(Database.layer, Auth.layer).pipe(
    Layer.provideMerge(pgClientLayer),
    Layer.provide(DatabasePool.layer(options))
  );
