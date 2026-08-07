import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BunFileSystem } from "@effect/platform-bun";
import { ProviderUsageSnapshot } from "@workspace/domain";
import { DateTime, Effect, Schema } from "effect";
import { FileSystem } from "effect/FileSystem";
import {
  type ProviderReading,
  providerReport,
  publishUsage,
  usagePathOf,
  usageSnapshot,
} from "./snapshot";
import { UNAVAILABLE_USAGE } from "./types";

const reading = (over: Partial<ProviderReading> = {}): ProviderReading => ({
  enforced: true,
  pausedUntilMs: null,
  pauseReason: null,
  provider: "claude",
  readAtMs: 1_700_000_000_000,
  reading: true,
  usage: {
    available: true,
    limitReached: false,
    primary: {
      resetsAtMs: 1_700_000_900_000,
      utilizationPercent: 40,
      windowSeconds: 18_000,
    },
    reachedWindow: null,
    secondary: {
      resetsAtMs: null,
      utilizationPercent: 12.5,
      windowSeconds: 604_800,
    },
  },
  ...over,
});

describe("providerReport", () => {
  test("publishes what is left, labelled with the window it belongs to", () => {
    const report = providerReport(reading());
    expect(report.state).toBe("ok");
    expect(report.windows).toHaveLength(2);

    const [primary, secondary] = report.windows;
    expect(primary?.kind).toBe("primary");
    expect(primary?.label).toBe("5h");
    expect(primary?.usedPercent).toBe(40);
    expect(primary?.remainingPercent).toBe(60);
    expect(primary?.resetsAt).not.toBeNull();

    expect(secondary?.kind).toBe("secondary");
    expect(secondary?.label).toBe("7d");
    expect(secondary?.remainingPercent).toBe(87.5);
    // Omitted by the source rather than invented here.
    expect(secondary?.resetsAt).toBeNull();
  });

  test("a window the provider did not size is labelled by role, not by a guess", () => {
    const report = providerReport(
      reading({
        usage: {
          available: true,
          limitReached: false,
          primary: {
            resetsAtMs: null,
            utilizationPercent: 5,
            windowSeconds: null,
          },
          reachedWindow: null,
          secondary: null,
        },
      })
    );
    expect(report.windows[0]?.label).toBe("short window");
    expect(report.windows[0]?.windowSeconds).toBeNull();
  });

  test("an unreadable signal is its own state, not a full tank", () => {
    const report = providerReport(reading({ usage: UNAVAILABLE_USAGE }));
    expect(report.state).toBe("unavailable");
    // Empty rather than zeroed: a 0% window renders as a full tank.
    expect(report.windows).toHaveLength(0);
    expect(report.note).toContain("no signal");
  });

  test("reads switched off say so, rather than reading as a failure", () => {
    const report = providerReport(
      reading({ reading: false, usage: UNAVAILABLE_USAGE })
    );
    expect(report.state).toBe("unavailable");
    expect(report.note).toBe("usage reads are switched off");
  });

  test("a live pause outranks the numbers behind it", () => {
    const report = providerReport(
      reading({
        pausedUntilMs: 1_700_000_600_000,
        pauseReason: "a run failed on a usage limit",
      })
    );
    expect(report.state).toBe("paused");
    expect(report.note).toBe("a run failed on a usage limit");
    expect(report.pausedUntil).not.toBeNull();
  });

  test("a provider that says it is out is not the same as one that is merely full", () => {
    const report = providerReport(
      reading({
        usage: {
          available: true,
          limitReached: true,
          primary: null,
          reachedWindow: "primary",
          secondary: null,
        },
      })
    );
    expect(report.state).toBe("limit_reached");
  });

  test("percentages are clamped, because a tank cannot hold less than nothing", () => {
    const report = providerReport(
      reading({
        usage: {
          available: true,
          limitReached: true,
          primary: {
            resetsAtMs: null,
            utilizationPercent: 130,
            windowSeconds: 18_000,
          },
          reachedWindow: null,
          secondary: null,
        },
      })
    );
    expect(report.windows[0]?.usedPercent).toBe(100);
    expect(report.windows[0]?.remainingPercent).toBe(0);
  });

  test("watching without acting is visible in the document", () => {
    expect(providerReport(reading({ enforced: false })).enforced).toBe(false);
  });
});

/**
 * The published file is read by another process out of another package, so what
 * is under test is that what the loop writes is what the gateway's schema
 * accepts — decoded here with the same schema the gateway decodes with, against
 * a real file, because a hand-rolled JSON blob in a test would only prove the
 * test agrees with itself.
 */
describe("publishUsage", () => {
  const decode = Schema.decodeUnknownEffect(ProviderUsageSnapshot);

  const inTempDir = <A, E>(
    use: (dir: string) => Effect.Effect<A, E, never>
  ) => {
    const dir = mkdtempSync(join(tmpdir(), "quota-snapshot-"));
    return Effect.runPromise(
      Effect.ensuring(
        use(dir),
        Effect.sync(() => {
          rmSync(dir, { force: true, recursive: true });
        })
      )
    );
  };

  test("writes a document the wire schema decodes, with both providers on it", async () => {
    await inTempDir((dir) =>
      Effect.gen(function* () {
        const fs = yield* FileSystem;
        const stateDir = join(dir, "quota");
        yield* publishUsage({
          fs,
          snapshot: usageSnapshot({
            nowMs: 1_700_000_000_000,
            readings: [
              reading(),
              reading({ provider: "codex", usage: UNAVAILABLE_USAGE }),
            ],
          }),
          stateDir,
        });

        const text = yield* fs.readFileString(usagePathOf(stateDir));
        const decoded = yield* decode(JSON.parse(text));
        expect(decoded.providers.map((entry) => entry.provider)).toEqual([
          "claude",
          "codex",
        ]);
        expect(decoded.providers[0]?.windows[0]?.remainingPercent).toBe(60);
        expect(decoded.providers[1]?.state).toBe("unavailable");
        expect(
          decoded.publishedAt === null
            ? null
            : DateTime.toEpochMillis(decoded.publishedAt)
        ).toBe(1_700_000_000_000);
      }).pipe(Effect.provide(BunFileSystem.layer))
    );
  });

  test("a directory it cannot write leaves the dispatch alone", async () => {
    await inTempDir((dir) =>
      Effect.gen(function* () {
        const fs = yield* FileSystem;
        // A path under a file, which no filesystem will make a directory of.
        const blocker = join(dir, "blocker");
        yield* fs.writeFileString(blocker, "not a directory");
        yield* publishUsage({
          fs,
          snapshot: usageSnapshot({ nowMs: 1, readings: [reading()] }),
          stateDir: join(blocker, "quota"),
        });
      }).pipe(Effect.provide(BunFileSystem.layer))
    );
  });
});
