import { describe, expect, test } from "bun:test";
import { ConfigProvider, Effect, Redacted } from "effect";
import {
  claudeExecutorMcpServers,
  codexExecutorConfig,
  EXECUTOR_KEY_ENV_VAR,
  EXECUTOR_TOOL_PREFIX,
  EXECUTOR_URL_ENV_VAR,
  makeExecutorMcp,
  readExecutorMcp,
} from "./executor-mcp";

const URL = "https://executor.sh/org_abc/mcp";
const KEY = "exec_key_abc123";

const executor = makeExecutorMcp({ key: KEY, url: URL });

describe("makeExecutorMcp", () => {
  test("resolves when both halves are present", () => {
    expect(executor?.url).toBe(URL);
    expect(executor === null ? null : Redacted.value(executor.key)).toBe(KEY);
  });

  test("trims both values", () => {
    expect(makeExecutorMcp({ key: ` ${KEY}\n`, url: ` ${URL} ` })?.url).toBe(
      URL
    );
  });

  test.each([
    ["no url", { key: KEY, url: null }],
    ["no key", { key: undefined, url: URL }],
    ["neither", { key: null, url: undefined }],
    ["a blank url", { key: KEY, url: "  " }],
    ["a blank key", { key: "", url: URL }],
  ])("is null with %s", (_name, input) => {
    expect(makeExecutorMcp(input)).toBeNull();
  });

  test("keeps the key out of an inspected object", () => {
    expect(JSON.stringify(executor)).not.toContain(KEY);
  });
});

describe("claudeExecutorMcpServers", () => {
  test("wires one http server with a bearer header", () => {
    expect(claudeExecutorMcpServers(executor)).toEqual({
      executor: {
        headers: { Authorization: `Bearer ${KEY}` },
        type: "http",
        url: URL,
      },
    });
  });

  test("is null when executor is unconfigured", () => {
    expect(claudeExecutorMcpServers(null)).toBeNull();
  });

  test("namespaces tools under the documented prefix", () => {
    expect(`${EXECUTOR_TOOL_PREFIX}execute`).toBe("mcp__executor__execute");
  });
});

describe("codexExecutorConfig", () => {
  test("names the env var instead of putting the key in the config", () => {
    expect(codexExecutorConfig(executor)).toEqual({
      config: {
        mcp_servers: {
          executor: {
            bearer_token_env_var: EXECUTOR_KEY_ENV_VAR,
            url: URL,
          },
        },
      },
      env: { [EXECUTOR_KEY_ENV_VAR]: KEY },
    });
  });

  test("keeps the key out of the config, which becomes argv", () => {
    expect(JSON.stringify(codexExecutorConfig(executor)?.config)).not.toContain(
      KEY
    );
  });

  test("is null when executor is unconfigured", () => {
    expect(codexExecutorConfig(null)).toBeNull();
  });
});

describe("readExecutorMcp", () => {
  const withEnv = (env: Readonly<Record<string, string>>) =>
    Effect.runSync(
      readExecutorMcp.pipe(
        Effect.provide(ConfigProvider.layer(ConfigProvider.fromUnknown(env)))
      )
    );

  test("reads both variables", () => {
    const resolved = withEnv({
      [EXECUTOR_KEY_ENV_VAR]: KEY,
      [EXECUTOR_URL_ENV_VAR]: URL,
    });
    expect(resolved?.url).toBe(URL);
  });

  test("is null when the environment configures nothing", () => {
    expect(withEnv({})).toBeNull();
  });

  test("is null when only the url is set", () => {
    expect(withEnv({ [EXECUTOR_URL_ENV_VAR]: URL })).toBeNull();
  });
});
