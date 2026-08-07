import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BunFileSystem } from "@effect/platform-bun";
import { Effect } from "effect";
import { FileSystem } from "effect/FileSystem";
import { FetchHttpClient, HttpClient } from "effect/unstable/http";
import {
  type ClaudeUsageOptions,
  fetchClaudeUsage,
  OAUTH_BETA_HEADER,
  parseOauthUsage,
} from "./claude-usage";
import fixture from "./fixtures/claude-oauth-usage.json";

describe("parseOauthUsage", () => {
  test("reads the captured live body the way the gate expects", () => {
    const usage = parseOauthUsage(fixture);
    expect(usage.available).toBe(true);
    expect(usage.limitReached).toBe(false);
    // `utilization` is already 0–100 on this endpoint: nothing is rescaled.
    expect(usage.primary?.utilizationPercent).toBe(4);
    // The account-wide weekly at 3% beats the sonnet bucket at 0%.
    expect(usage.secondary?.utilizationPercent).toBe(3);
    expect(usage.primary?.resetsAtMs).toBe(
      Date.parse("2026-06-16T14:30:00.351191+00:00")
    );
    expect(usage.reachedWindow).toBeNull();
    // The span is stated by this body in its key names, and read as a number so
    // whoever renders the figure can say which window it belongs to.
    expect(usage.primary?.windowSeconds).toBe(18_000);
    expect(usage.secondary?.windowSeconds).toBe(604_800);
  });

  test("a per-model weekly window can be the binding one", () => {
    const usage = parseOauthUsage({
      five_hour: { resets_at: null, utilization: 10 },
      seven_day: { resets_at: null, utilization: 20 },
      seven_day_opus: { resets_at: "2026-06-18T00:00:00Z", utilization: 88 },
      seven_day_sonnet: null,
    });
    expect(usage.secondary?.utilizationPercent).toBe(88);
    expect(usage.secondary?.resetsAtMs).toBe(
      Date.parse("2026-06-18T00:00:00Z")
    );
  });

  test("a weekly bucket nobody listed still binds, because the scan is by prefix", () => {
    const usage = parseOauthUsage({
      seven_day: { resets_at: null, utilization: 5 },
      seven_day_something_new: { resets_at: null, utilization: 91 },
    });
    expect(usage.secondary?.utilizationPercent).toBe(91);
  });

  test("paid overflow already spending is a drain, not a healthy read", () => {
    const usage = parseOauthUsage({
      extra_usage: { is_enabled: true, used_credits: 12.5 },
      five_hour: { resets_at: "2026-06-16T14:30:00Z", utilization: 40 },
      seven_day: { resets_at: null, utilization: 70 },
    });
    expect(usage.limitReached).toBe(true);
    // The short window, so the gate re-checks in hours rather than idling a week.
    expect(usage.reachedWindow).toBe("primary");
  });

  test("overflow that is enabled and unspent is not a drain", () => {
    expect(
      parseOauthUsage({
        extra_usage: { is_enabled: true, used_credits: 0 },
        five_hour: { resets_at: null, utilization: 40 },
      }).limitReached
    ).toBe(false);
    expect(
      parseOauthUsage({
        extra_usage: { is_enabled: false, used_credits: 5 },
        five_hour: { resets_at: null, utilization: 40 },
      }).limitReached
    ).toBe(false);
  });

  test("a window pinned at 100% is the drain there is no flag for", () => {
    const usage = parseOauthUsage({
      five_hour: { resets_at: null, utilization: 100 },
      seven_day: { resets_at: null, utilization: 100 },
    });
    expect(usage.limitReached).toBe(true);
    // The longest wait wins, so the resume time is not optimistic.
    expect(usage.reachedWindow).toBe("secondary");
  });

  test("a body that changed shape reads as unavailable, never as drained", () => {
    for (const raw of [null, undefined, "nope", 42]) {
      const usage = parseOauthUsage(raw);
      expect(usage.available).toBe(false);
      expect(usage.limitReached).toBe(false);
    }
  });

  test("a garbled window degrades that window, not the whole read", () => {
    const usage = parseOauthUsage({
      five_hour: { resets_at: "not a date", utilization: 12 },
      seven_day: { utilization: "lots" },
    });
    expect(usage.available).toBe(true);
    expect(usage.primary?.resetsAtMs).toBeNull();
    expect(usage.secondary).toBeNull();
  });
});

const withTempAuth = (contents: string | null) => {
  const dir = mkdtempSync(join(tmpdir(), "claude-usage-"));
  const authPath = join(dir, ".credentials.json");
  if (contents !== null) {
    writeFileSync(authPath, contents);
  }
  return {
    agentHomeDir: dir,
    cleanup: () => rmSync(dir, { force: true, recursive: true }),
  };
};

const readUsage = (input: {
  readonly agentHomeDir: string;
  readonly options: ClaudeUsageOptions;
}) =>
  Effect.runPromise(
    Effect.gen(function* () {
      const fs = yield* FileSystem;
      const http = yield* HttpClient.HttpClient;
      return yield* fetchClaudeUsage({ ...input, fs, http });
    }).pipe(
      Effect.provide(BunFileSystem.layer),
      Effect.provide(FetchHttpClient.layer)
    )
  );

describe("fetchClaudeUsage", () => {
  test("a missing credentials file fails open rather than failing the dispatch", async () => {
    const { agentHomeDir, cleanup } = withTempAuth(null);
    try {
      const usage = await readUsage({
        agentHomeDir,
        options: { url: "http://127.0.0.1:1/" },
      });
      expect(usage.available).toBe(false);
      expect(usage.limitReached).toBe(false);
    } finally {
      cleanup();
    }
  });

  test("a credentials file with no token fails open too", async () => {
    const { agentHomeDir, cleanup } = withTempAuth(
      JSON.stringify({ other: 1 })
    );
    try {
      const usage = await readUsage({
        agentHomeDir,
        options: { url: "http://127.0.0.1:1/" },
      });
      expect(usage.available).toBe(false);
    } finally {
      cleanup();
    }
  });

  test("an unreachable endpoint fails open with a token in hand", async () => {
    const { agentHomeDir, cleanup } = withTempAuth(
      JSON.stringify({ claudeAiOauth: { accessToken: "test-token" } })
    );
    try {
      const usage = await readUsage({
        agentHomeDir,
        // Port 1 refuses immediately, so this is a connection failure and not a
        // test that waits on a timeout.
        options: { url: "http://127.0.0.1:1/usage" },
      });
      expect(usage.available).toBe(false);
    } finally {
      cleanup();
    }
  });
});

/** The shape Anthropic dates its beta tags with. */
const BETA_TAG = /^oauth-\d{4}-\d{2}-\d{2}$/;

test("the beta header is a constant the config can rotate, not a literal in the request", () => {
  expect(OAUTH_BETA_HEADER).toMatch(BETA_TAG);
});
