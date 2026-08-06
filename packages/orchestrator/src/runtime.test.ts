/**
 * What the loop hands a turn, asserted without starting one.
 *
 * The environment a run is given is a security boundary drawn as a list of
 * names, so it is worth a test that reads like the list: these two variables
 * cross, everything else the host holds does not, and the loop's own
 * observability export least of all. Pure over a `ConfigProvider`, because the
 * question is what the loop *builds* — that the container then receives exactly
 * this is `./container-turn.test`, which asks a real container to name the
 * variables it was started with.
 */

import { describe, expect, test } from "bun:test";
import {
  CLAUDE_SETTINGS_ENV_VAR,
  EXECUTOR_KEY_ENV_VAR,
  EXECUTOR_URL_ENV_VAR,
} from "@workspace/harness";
import {
  AGENT_TOKEN_ENV_VAR,
  GH_TOKEN_ENV_VAR,
  GITHUB_TOKEN_ENV_VAR,
} from "@workspace/sandbox";
import { ConfigProvider, Effect } from "effect";
import { turnEnvironment } from "./runtime";

const URL = "https://executor.sh/org_abc/mcp";
const KEY = "exec_key_abc123";

/** The loop's turn environment, over an environment stated here rather than inherited. */
const withEnv = (env: Readonly<Record<string, string>>) =>
  Effect.runSync(
    turnEnvironment.pipe(
      Effect.provide(ConfigProvider.layer(ConfigProvider.fromUnknown(env)))
    )
  );

describe("turnEnvironment", () => {
  test("carries both halves of the executor credential", () => {
    expect(
      withEnv({ [EXECUTOR_KEY_ENV_VAR]: KEY, [EXECUTOR_URL_ENV_VAR]: URL })
    ).toEqual({
      [EXECUTOR_KEY_ENV_VAR]: KEY,
      [EXECUTOR_URL_ENV_VAR]: URL,
    });
  });

  test.each([
    ["only the url is set", { [EXECUTOR_URL_ENV_VAR]: URL }],
    ["only the key is set", { [EXECUTOR_KEY_ENV_VAR]: KEY }],
    ["neither is set", {}],
  ])("is empty when %s", (_name, env) => {
    expect(withEnv(env)).toEqual({});
  });

  test("forwards nothing else the host happens to hold", () => {
    const built = withEnv({
      AWS_SECRET_ACCESS_KEY: "not a turn's business",
      [EXECUTOR_KEY_ENV_VAR]: KEY,
      [EXECUTOR_URL_ENV_VAR]: URL,
      GH_TOKEN: "ghp_the_operators_own",
      OTEL_EXPORTER_OTLP_ENDPOINT: "https://collector.example",
      OTEL_EXPORTER_OTLP_HEADERS: "Authorization=Bearer sk-live-1234",
    });
    expect(Object.keys(built).sort()).toEqual([
      EXECUTOR_KEY_ENV_VAR,
      EXECUTOR_URL_ENV_VAR,
    ]);
  });

  /**
   * The overlay is forwarded verbatim and read on the other side. Trimmed only,
   * because a shell writing `NAME=` means unset and an empty string handed to a
   * container is a settings file the harness would then refuse to parse.
   */
  test("carries the agent settings overlay across, blank or not at all", () => {
    const overlay = '{"permissions":{"deny":[]}}';
    expect(withEnv({ [CLAUDE_SETTINGS_ENV_VAR]: ` ${overlay} ` })).toEqual({
      [CLAUDE_SETTINGS_ENV_VAR]: overlay,
    });
    expect(withEnv({ [CLAUDE_SETTINGS_ENV_VAR]: "  " })).toEqual({});
  });

  /**
   * The GitHub credential is an opt-in, and the line above is what it must not
   * cross: a turn gets the token the operator wrote in the loop's environment,
   * under the names `gh` and git read, and never the one the host happened to
   * export for its own shell.
   */
  test("hands the opt-in GitHub token over under the names the tools read", () => {
    const built = withEnv({
      [AGENT_TOKEN_ENV_VAR]: "ghp_meant_for_agents",
      GH_TOKEN: "ghp_the_operators_own",
    });
    expect(built[GH_TOKEN_ENV_VAR]).toBe("ghp_meant_for_agents");
    expect(built[GITHUB_TOKEN_ENV_VAR]).toBe("ghp_meant_for_agents");
  });
});
