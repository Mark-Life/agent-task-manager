/**
 * The GitHub credential, on the host that materializes a checkout and inside
 * the container that works on it.
 *
 * Before this, the only place a credential could live was the project's
 * `repoUrl` — a token in a database column, rendered by the dashboard, copied
 * into every log line that printed a project. It also only ever solved half the
 * problem: it let the host clone, and left the agent with a `gh` that was not
 * logged in.
 *
 * So the token travels as an environment variable and nothing else. The
 * operator sets {@link AGENT_TOKEN_ENV_VAR}; a turn is handed it under the names
 * the tools already read, so `gh` is logged in with no configuration at all and
 * git reads the same value through {@link CREDENTIAL_HELPER}. One value, two
 * tools, and a `repoUrl` that stays a URL.
 *
 * The two names are deliberately different. What a turn gets is what this
 * system decided to give it — an operator holding `GH_TOKEN` in their own shell
 * has not thereby decided that every agent should have it.
 *
 * **What an agent can do with it is what the token can do.** The helper is
 * written into the run's checkout, which is mounted read-write into the
 * container, and the variable is on the container's environment — so a turn can
 * read the token and use it against anything in its scope. That is the point:
 * an agent that opens pull requests needs to push. It is also the reason to
 * scope the token to the repositories the board actually works on rather than
 * handing over an account-wide one.
 */

import { Config, Effect, Option, Redacted } from "effect";

/**
 * What the operator sets, and deliberately **not** `GH_TOKEN`.
 *
 * A turn is given what this system decided to give it, never what the host
 * happens to be holding — an operator with `GH_TOKEN` exported for their own
 * shell has not thereby decided that every agent should have it. Reading a
 * name nothing else uses is what keeps that an opt-in: the value arrives here
 * because somebody wrote it in the loop's environment file and for no other
 * reason.
 */
export const AGENT_TOKEN_ENV_VAR = "ATM_GITHUB_TOKEN";

/**
 * What the tools read, once the token is on its way in.
 *
 * `GH_TOKEN` wins over `GITHUB_TOKEN` in the CLI's own precedence, and both are
 * set because half the world's actions and scripts read the other one.
 */
export const GH_TOKEN_ENV_VAR = "GH_TOKEN";
export const GITHUB_TOKEN_ENV_VAR = "GITHUB_TOKEN";

/**
 * The username half of a GitHub HTTPS credential. GitHub ignores it for a
 * personal access token and requires *something*, so this is the conventional
 * placeholder rather than a value with meaning.
 */
const CREDENTIAL_USERNAME = "x-access-token";

/**
 * A git credential helper that answers from the environment.
 *
 * Written as a shell function because that is the only shape git accepts inline,
 * and inline is what keeps the token out of argv: `ps` on the host shows this
 * text, which names a variable and never holds a value. The `get` guard matters
 * — git also calls a helper with `store` and `erase`, and a helper that printed
 * a credential in reply to `erase` would be answering a question about
 * forgetting one.
 */
export const CREDENTIAL_HELPER = `!f() { test "$1" = get && printf '%s\\n' "username=${CREDENTIAL_USERNAME}" "password=\${${GH_TOKEN_ENV_VAR}}"; }; f`;

/**
 * The `-c` pair that installs the helper for one invocation.
 *
 * The empty assignment first is not redundant: git's credential helpers are a
 * list rather than a single setting, and a host with a `credential.helper` in
 * its own `~/.gitconfig` — a keychain, a manager, an `osxkeychain` left over
 * from a laptop — would otherwise be consulted first and answer with the wrong
 * account. Clearing the list and then appending exactly one is how this stays
 * independent of whatever the operator's git is configured to do.
 */
export const credentialConfigArgs: readonly string[] = [
  "-c",
  "credential.helper=",
  "-c",
  `credential.helper=${CREDENTIAL_HELPER}`,
];

/**
 * The environment a subprocess needs to use the credential, or nothing when
 * none is configured.
 *
 * Both names carry the same value: the helper and `gh` agree on `GH_TOKEN`,
 * while a tool an agent installs itself is as likely to look for the other.
 */
export const githubTokenEnv = (
  token: Redacted.Redacted | null
): Readonly<Record<string, string>> =>
  token === null
    ? {}
    : {
        [GH_TOKEN_ENV_VAR]: Redacted.value(token),
        [GITHUB_TOKEN_ENV_VAR]: Redacted.value(token),
      };

/**
 * The configured token, or null.
 *
 * Absence is not an error and never becomes one. A board whose projects are all
 * public repositories needs no credential, and an install that has not set one
 * should get a clone that fails on the repository it cannot read rather than a
 * loop that refuses to boot.
 */
export const readGithubToken = Effect.gen(function* () {
  const configured = yield* Config.option(Config.redacted(AGENT_TOKEN_ENV_VAR));
  return Option.getOrNull(configured);
}).pipe(
  // Total, so a checkout's failure channel stays `CloneFailed` alone. A
  // configuration this cannot read is a run with no credential, which fails on
  // the repository it cannot reach and says so — not a `ConfigError` surfacing
  // from inside a clone, where nothing downstream knows what to do with it.
  Effect.orElseSucceed(() => null)
);
