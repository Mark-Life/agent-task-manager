import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BunFileSystem } from "@effect/platform-bun";
import { Effect } from "effect";
import { FileSystem } from "effect/FileSystem";
import { FetchHttpClient, HttpClient } from "effect/unstable/http";
import {
  type CodexUsageOptions,
  fetchCodexUsage,
  parseWhamUsage,
} from "./codex-usage";
import fixture from "./fixtures/wham-usage.json";

describe("parseWhamUsage", () => {
  test("reads the captured live body the way the gate expects", () => {
    const usage = parseWhamUsage(fixture);
    expect(usage.available).toBe(true);
    expect(usage.limitReached).toBe(false);
    expect(usage.primary?.utilizationPercent).toBe(1);
    expect(usage.secondary?.utilizationPercent).toBe(3);
    // `reset_at` is unix seconds on this endpoint; everything else is millis.
    expect(usage.primary?.resetsAtMs).toBe(1_781_287_930_000);
    expect(usage.reachedWindow).toBeNull();
  });

  test("either spelling of the reached flag is a drain", () => {
    expect(
      parseWhamUsage({ rate_limit: { allowed: true, limit_reached: true } })
        .limitReached
    ).toBe(true);
    expect(
      parseWhamUsage({ rate_limit: { allowed: false, limit_reached: false } })
        .limitReached
    ).toBe(true);
  });

  test("the named window is carried through so the resume time is the right one", () => {
    const usage = parseWhamUsage({
      rate_limit: {
        limit_reached: true,
        secondary_window: { reset_at: 1_700_000_000, used_percent: 100 },
      },
      rate_limit_reached_type: "secondary",
    });
    expect(usage.reachedWindow).toBe("secondary");
    expect(usage.secondary?.resetsAtMs).toBe(1_700_000_000_000);
  });

  test("a window name nobody knows is dropped rather than guessed at", () => {
    expect(
      parseWhamUsage({
        rate_limit: { limit_reached: true },
        rate_limit_reached_type: "tertiary",
      }).reachedWindow
    ).toBeNull();
  });

  test("a body without the rate-limit object is unavailable, not empty", () => {
    for (const raw of [null, undefined, "nope", {}, { rate_limit: null }]) {
      const usage = parseWhamUsage(raw);
      expect(usage.available).toBe(false);
      expect(usage.limitReached).toBe(false);
    }
  });

  test("a garbled window degrades that window, not the whole read", () => {
    const usage = parseWhamUsage({
      rate_limit: {
        limit_reached: false,
        primary_window: { reset_at: "soon", used_percent: 40 },
        secondary_window: { used_percent: null },
      },
    });
    expect(usage.available).toBe(true);
    expect(usage.primary?.resetsAtMs).toBeNull();
    expect(usage.secondary).toBeNull();
  });
});

const withTempAuth = (contents: string | null) => {
  const dir = mkdtempSync(join(tmpdir(), "codex-usage-"));
  const authPath = join(dir, "auth.json");
  if (contents !== null) {
    writeFileSync(authPath, contents);
  }
  return {
    authPath,
    cleanup: () => rmSync(dir, { force: true, recursive: true }),
  };
};

const readUsage = (options: CodexUsageOptions) =>
  Effect.runPromise(
    Effect.gen(function* () {
      const fs = yield* FileSystem;
      const http = yield* HttpClient.HttpClient;
      return yield* fetchCodexUsage({ fs, http, options });
    }).pipe(
      Effect.provide(BunFileSystem.layer),
      Effect.provide(FetchHttpClient.layer)
    )
  );

describe("fetchCodexUsage", () => {
  test("a missing credentials file fails open rather than failing the dispatch", async () => {
    const { authPath, cleanup } = withTempAuth(null);
    try {
      const usage = await readUsage({ authPath, url: "http://127.0.0.1:1/" });
      expect(usage.available).toBe(false);
      expect(usage.limitReached).toBe(false);
    } finally {
      cleanup();
    }
  });

  test("malformed credentials fail open too", async () => {
    const { authPath, cleanup } = withTempAuth("{not json");
    try {
      const usage = await readUsage({ authPath, url: "http://127.0.0.1:1/" });
      expect(usage.available).toBe(false);
    } finally {
      cleanup();
    }
  });

  test("an unreachable endpoint fails open with a token in hand", async () => {
    const { authPath, cleanup } = withTempAuth(
      JSON.stringify({ tokens: { access_token: "test-token" } })
    );
    try {
      const usage = await readUsage({
        authPath,
        url: "http://127.0.0.1:1/usage",
      });
      expect(usage.available).toBe(false);
    } finally {
      cleanup();
    }
  });
});
