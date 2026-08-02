/**
 * What the stdio server is told about the gateway, and how it is told.
 *
 * Both values arrive in the process environment rather than on the command
 * line, because argv is world-readable to every process on the host while a
 * child's environment is not. They are written into the provider's MCP server
 * map (see `./provider-config`), which lives on a mount the container reads and
 * is deleted after the turn — so the token exists in exactly one place for
 * exactly as long as the turn it was minted for.
 *
 * The token is `Redacted` from the moment it is read, so a configuration object
 * printed whole in a stack trace does not print the credential.
 */

import { Config, Effect, type Redacted } from "effect";

/** The gateway's base url **as the container sees it**, e.g. `http://host.docker.internal:3100`. */
export const GATEWAY_URL_ENV_VAR = "ATM_GATEWAY_URL";

/** The manager's bearer token for this turn, minted by the bot at `task-write`. */
export const GATEWAY_TOKEN_ENV_VAR = "ATM_GATEWAY_TOKEN";

/** Where the tools send their requests, and what they authenticate with. */
export interface GatewayConfig {
  readonly baseUrl: string;
  readonly token: Redacted.Redacted;
}

/**
 * The gateway configuration, or a failed layer build naming the missing
 * variable. There is no default and no fallback: a server that starts with no
 * token would answer every tool call with a 401 the model then narrates as a
 * board problem.
 */
export const readGatewayConfig = Effect.gen(function* () {
  const baseUrl = yield* Config.string(GATEWAY_URL_ENV_VAR);
  const token = yield* Config.redacted(GATEWAY_TOKEN_ENV_VAR);
  return { baseUrl, token } satisfies GatewayConfig;
});
