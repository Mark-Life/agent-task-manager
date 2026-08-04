import { describe, expect, test } from "bun:test";
import { ConfigProvider, Effect } from "effect";
import { orchestratorConfig, retryDelayMs, shouldPark } from "./config";

const load = (environment: Readonly<Record<string, string>>) =>
  Effect.runSync(
    orchestratorConfig.pipe(
      Effect.provide(
        ConfigProvider.layer(ConfigProvider.fromUnknown(environment))
      )
    )
  );

const policy = { maxAttempts: 5, retryBaseMs: 60_000, retryMaxMs: 1_800_000 };

describe("orchestratorConfig", () => {
  test("boots on an empty environment, and isolates runs when nobody said otherwise", () => {
    const config = load({});
    expect(config.maxConcurrency).toBe(2);
    expect(config.sandboxKind).toBe("docker");
    expect(config.defaultProvider).toBe("claude");
  });

  test("keeps the lease stale threshold above one missed heartbeat", () => {
    const config = load({});
    expect(config.leaseStaleMs).toBeGreaterThan(config.leaseHeartbeatMs * 2);
  });

  test("reads the operator's overrides", () => {
    const config = load({
      ORCHESTRATOR_DEFAULT_PROVIDER: "codex",
      ORCHESTRATOR_MAX_CONCURRENCY: "3",
      SANDBOX_MODE: "local",
    });
    expect(config.maxConcurrency).toBe(3);
    expect(config.defaultProvider).toBe("codex");
    expect(config.sandboxKind).toBe("local");
  });

  test("refuses a provider that is not one of ours rather than picking one", () => {
    expect(() => load({ ORCHESTRATOR_DEFAULT_PROVIDER: "gemini" })).toThrow();
  });
});

describe("retryDelayMs", () => {
  test("doubles from the base and stops at the ceiling", () => {
    expect(retryDelayMs({ attempt: 1, policy })).toBe(60_000);
    expect(retryDelayMs({ attempt: 2, policy })).toBe(120_000);
    expect(retryDelayMs({ attempt: 3, policy })).toBe(240_000);
    expect(retryDelayMs({ attempt: 40, policy })).toBe(1_800_000);
  });
});

describe("shouldPark", () => {
  test("parks once the last attempt has failed", () => {
    expect(shouldPark({ attempt: 4, policy })).toBe(false);
    expect(shouldPark({ attempt: 5, policy })).toBe(true);
  });
});
