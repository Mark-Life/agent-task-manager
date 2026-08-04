import { describe, expect, it } from "bun:test";
import type { OrchestratorConfig } from "@workspace/orchestrator";
import { bannerFields } from "./banner";
import { SERVICE_NAME } from "./identity";

/**
 * A resolved config whose values are all distinct, so "this setting reached the
 * banner" is a question about the value and not about a coincidence.
 */
const config: OrchestratorConfig = {
  agentHomeDirs: {
    claude: "/tmp/atm-banner-test/claude-home",
    codex: "/tmp/atm-banner-test/codex-home",
  },
  agentTokenTtlMs: 1011,
  chatTimeoutMs: 1012,
  dataRoot: "/tmp/atm-banner-test",
  defaultProvider: "codex",
  gatewayUrl: "https://gateway.invalid",
  leaseHeartbeatMs: 1001,
  leaseStaleMs: 1002,
  maxAttempts: 1003,
  maxChatConcurrency: 1013,
  maxConcurrency: 1004,
  parkMs: 1005,
  pollIntervalMs: 1006,
  retryBaseMs: 1007,
  retryMaxMs: 1008,
  runTimeoutMs: 1009,
  sandboxKind: "local",
  skillsDir: "/tmp/atm-banner-test/skills",
};

const input = {
  config,
  instance: "host/42/deadbeef",
  ledgerPath: "/tmp/atm-banner-test/events/loop.jsonl",
  otlp: false,
  shutdownGraceMs: 1010,
};

describe("bannerFields", () => {
  it("carries every resolved setting", () => {
    const values = new Set<unknown>(Object.values(bannerFields(input)));
    for (const setting of Object.values(config)) {
      expect(values).toContain(setting);
    }
  });

  it("names the service the ledger viewer reads", () => {
    // `bun run logs` opens `<service>.jsonl`; a rename here is an empty viewer.
    expect(bannerFields(input).service).toBe(SERVICE_NAME);
    expect(SERVICE_NAME).toBe("loop");
  });

  it("reports the OTLP sink as a state, never as an endpoint", () => {
    expect(bannerFields(input).otlp).toBe("off");
    expect(bannerFields({ ...input, otlp: true }).otlp).toBe("on");
  });

  it("carries the instance id a lease row is stamped with", () => {
    expect(bannerFields(input).instance).toBe(input.instance);
  });
});
