/**
 * What the stdio server is told about the gateway, and how it is told.
 *
 * Both values arrive in the process environment rather than on the command
 * line, because argv is world-readable to every process on the host while a
 * child's environment is not. They are written into the provider's MCP server
 * map (see `./provider-config`), which lives on a mount the container reads and
 * is deleted after the turn.
 *
 * **The credential is a path, not a value.** A token in the environment is
 * fixed for the life of the process, and this process lives exactly as long as
 * the turn — so a turn that outlasts one token lifetime spends the rest of
 * itself holding a credential the gateway refuses, which a model narrates
 * rather than fails on. Naming a file instead means the host can replace what
 * is in it while the turn runs, and every request reads what is there now. The
 * file sits on the run mount the turn already has.
 *
 * `ATM_GATEWAY_TOKEN` is still read when no path is given: the token then lives
 * for as long as the process does, which is what a host-side turn or a one-off
 * invocation wants. A path wins where both are set — a deployment that rolls
 * its credential should never fall back to a stale copy of it.
 */

import { readFile } from "node:fs/promises";
import { Config, Effect, Redacted, Schema } from "effect";

/** The gateway's base url **as the container sees it**, e.g. `http://host.docker.internal:3100`. */
export const GATEWAY_URL_ENV_VAR = "ATM_GATEWAY_URL";

/** A bearer token for this turn, fixed for the life of the server process. */
export const GATEWAY_TOKEN_ENV_VAR = "ATM_GATEWAY_TOKEN";

/** The file the turn's bearer token is read from, re-read on every request. */
export const GATEWAY_TOKEN_FILE_ENV_VAR = "ATM_GATEWAY_TOKEN_FILE";

/**
 * Where a request's bearer token comes from.
 *
 * The two cases are a real difference in lifetime rather than two spellings of
 * one thing, so they are a union: `file` is re-read per request and can change
 * or be taken away underneath the process, `value` is what the server started
 * with and stays that way.
 */
export type GatewayCredential =
  | { readonly kind: "file"; readonly path: string }
  | { readonly kind: "value"; readonly token: Redacted.Redacted };

/** Where the tools send their requests, and what they authenticate with. */
export interface GatewayConfig {
  readonly baseUrl: string;
  readonly credential: GatewayCredential;
}

/**
 * The credential file was not there, or held nothing.
 *
 * Its own failure rather than a request sent unauthenticated: the gateway's
 * answer to the latter is a `401` that reads exactly like an expired token, and
 * the whole point of the file is to tell those two apart. An empty file counts
 * as absent because a truncated write and a deleted credential are the same
 * thing to a reader — the writer renames a complete file into place precisely
 * so this case means "the turn's access is over".
 */
export class GatewayTokenUnreadable extends Schema.TaggedErrorClass<GatewayTokenUnreadable>()(
  "AgentTools.GatewayTokenUnreadable",
  { detail: Schema.String, path: Schema.String }
) {
  override get message() {
    return `the board credential could not be read from ${this.path}: ${this.detail}`;
  }
}

/**
 * The credential as it is right now.
 *
 * Nothing is cached between calls. A cache would mean a turn whose credential
 * has been deleted keeps writing to the board, which turns the one revocation
 * this token shape has into no revocation at all — and the read is a few
 * hundred bytes off a directory the host has open anyway.
 */
export const currentGatewayToken = (credential: GatewayCredential) =>
  credential.kind === "value"
    ? Effect.succeed(credential.token)
    : Effect.tryPromise({
        catch: (cause) =>
          new GatewayTokenUnreadable({
            detail: String(cause),
            path: credential.path,
          }),
        try: () => readFile(credential.path, "utf8"),
      }).pipe(
        Effect.flatMap((contents) => {
          const token = contents.trim();
          return token.length === 0
            ? Effect.fail(
                new GatewayTokenUnreadable({
                  detail: "the file is empty",
                  path: credential.path,
                })
              )
            : Effect.succeed(Redacted.make(token));
        })
      );

/** The path, or the literal token, or a failed layer build naming both variables. */
const credentialConfig: Config.Config<GatewayCredential> = Config.string(
  GATEWAY_TOKEN_FILE_ENV_VAR
).pipe(
  Config.map((path) => ({ kind: "file", path }) as const),
  Config.orElse(() =>
    Config.redacted(GATEWAY_TOKEN_ENV_VAR).pipe(
      Config.map((token) => ({ kind: "value", token }) as const)
    )
  )
);

/**
 * The gateway configuration, or a failed layer build naming what is missing.
 * There is no default and no fallback: a server that starts with no credential
 * at all would answer every tool call with a 401 the model then narrates as a
 * board problem.
 */
export const readGatewayConfig = Effect.gen(function* () {
  const baseUrl = yield* Config.string(GATEWAY_URL_ENV_VAR);
  const credential = yield* credentialConfig;
  return { baseUrl, credential } satisfies GatewayConfig;
});
