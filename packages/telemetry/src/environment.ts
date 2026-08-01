import { hostname } from "node:os";
import { Config, Effect } from "effect";
import type { Environment } from "./event";

/** Value used where the environment stamp is genuinely unknown. */
export const UNKNOWN = "unknown";

/**
 * The build this process is running, read from `SERVICE_VERSION`.
 *
 * Single-sourced on purpose: it is stamped on every ledger row as `version` and
 * exported as the OTLP resource's `service.version`, and the two must name the
 * same build or a backend disagrees with the ledger about what ran.
 */
export const serviceVersionConfig = Config.string("SERVICE_VERSION").pipe(
  Config.withDefault(UNKNOWN)
);

/** Commit this process was built from, read from `GIT_SHA`. */
export const gitShaConfig = Config.string("GIT_SHA").pipe(
  Config.withDefault(UNKNOWN)
);

/** Reads the environment stamp once, at layer construction. */
export const loadEnvironment = Effect.gen(function* () {
  const version = yield* serviceVersionConfig;
  const gitSha = yield* gitShaConfig;
  return { gitSha, host: hostname(), version } satisfies Environment;
});
