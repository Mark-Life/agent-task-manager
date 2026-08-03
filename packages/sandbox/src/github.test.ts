import { describe, expect, test } from "bun:test";
import { ConfigProvider, Effect, Redacted } from "effect";
import {
  AGENT_TOKEN_ENV_VAR,
  CREDENTIAL_HELPER,
  credentialConfigArgs,
  GH_TOKEN_ENV_VAR,
  GITHUB_TOKEN_ENV_VAR,
  githubTokenEnv,
  readGithubToken,
} from "./github";

/** Runs the reader against a fixed environment rather than the host's. */
const readFrom = (env: Record<string, string>) =>
  Effect.runPromise(
    readGithubToken.pipe(
      Effect.provide(ConfigProvider.layer(ConfigProvider.fromUnknown(env)))
    )
  );

describe("readGithubToken", () => {
  test("is null when nothing is configured", async () => {
    expect(await readFrom({})).toBeNull();
  });

  test("reads the opt-in variable", async () => {
    const token = await readFrom({ [AGENT_TOKEN_ENV_VAR]: "deliberate" });
    expect(token === null ? null : Redacted.value(token)).toBe("deliberate");
  });

  /**
   * The guarantee this name exists for. An operator with `GH_TOKEN` exported
   * for their own shell has not decided that every agent should hold it, and
   * reading a name nothing else uses is what keeps the two apart.
   */
  test("ignores the host's own GH_TOKEN and GITHUB_TOKEN", async () => {
    expect(
      await readFrom({
        [GH_TOKEN_ENV_VAR]: "the operator's own",
        [GITHUB_TOKEN_ENV_VAR]: "also theirs",
      })
    ).toBeNull();
  });
});

describe("githubTokenEnv", () => {
  test("is empty when there is no token, so nothing is set to a blank", () => {
    expect(githubTokenEnv(null)).toEqual({});
  });

  test("sets both names to the one value", () => {
    expect(githubTokenEnv(Redacted.make("t"))).toEqual({
      [GH_TOKEN_ENV_VAR]: "t",
      [GITHUB_TOKEN_ENV_VAR]: "t",
    });
  });
});

describe("the credential helper", () => {
  /**
   * The whole point of the helper being a shell snippet: `ps` shows this text
   * on every clone, so it must name the variable and never hold the value.
   */
  test("names the variable and carries no secret", () => {
    expect(CREDENTIAL_HELPER).toContain(`\${${GH_TOKEN_ENV_VAR}}`);
    expect(CREDENTIAL_HELPER).toContain("username=x-access-token");
  });

  /**
   * git calls a helper with `store` and `erase` too. Answering either with a
   * credential is answering a question about forgetting one.
   */
  test("answers only the get action", () => {
    expect(CREDENTIAL_HELPER).toContain('test "$1" = get');
  });

  /**
   * A host with its own `credential.helper` — a keychain, a manager left over
   * from a laptop — is consulted first unless the list is cleared, and answers
   * for the wrong account.
   */
  test("clears any inherited helper before appending its own", () => {
    expect(credentialConfigArgs.slice(0, 2)).toEqual([
      "-c",
      "credential.helper=",
    ]);
    expect(credentialConfigArgs.at(-1)).toBe(
      `credential.helper=${CREDENTIAL_HELPER}`
    );
  });
});
