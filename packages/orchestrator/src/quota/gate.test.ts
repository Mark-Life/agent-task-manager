import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BunFileSystem } from "@effect/platform-bun";
import { ProviderUsageSnapshot, type SessionProvider } from "@workspace/domain";
import { Effect, type Layer, Schema } from "effect";
import { FileSystem } from "effect/FileSystem";
import { TestClock } from "effect/testing";
import { QuotaGate, type QuotaGateOptions } from "./gate";
import type { ProviderUsage } from "./types";

const directories: string[] = [];

afterEach(() => {
  for (const directory of directories.splice(0)) {
    rmSync(directory, { force: true, recursive: true });
  }
});

const stateDir = () => {
  const directory = mkdtempSync(join(tmpdir(), "quota-gate-"));
  directories.push(directory);
  return directory;
};

const usage = (over: Partial<ProviderUsage> = {}): ProviderUsage => ({
  available: true,
  limitReached: false,
  primary: { resetsAtMs: 1000, utilizationPercent: 0, windowSeconds: 18_000 },
  reachedWindow: null,
  secondary: {
    resetsAtMs: 2000,
    utilizationPercent: 0,
    windowSeconds: 604_800,
  },
  ...over,
});

const BASE = {
  // Somewhere that does not exist, deliberately: a test whose real reader is not
  // injected must fail to find a login rather than read the host's own.
  agentHomeDirs: {
    claude: join(tmpdir(), "quota-gate-absent-claude"),
    codex: join(tmpdir(), "quota-gate-absent-codex"),
  },
  cooldownMs: 900_000,
  enabled: true,
  headroomPercent: 5,
  pollIntervalMs: 180_000,
  proactive: true,
  providers: ["claude", "codex"] as readonly SessionProvider[],
  read: true,
  thresholdPercent: 80,
} satisfies Omit<QuotaGateOptions, "readers" | "stateDir">;

const gateLayer = (options: Partial<QuotaGateOptions> = {}) =>
  QuotaGate.layer({ ...BASE, stateDir: stateDir(), ...options });

/**
 * The real filesystem, on a temporary directory. The pause record surviving a
 * restart is one of the properties under test, so a fake here would be the thing
 * being tested. The clock is the test one, because every wait in the gate is
 * measured in hours.
 */
const run = <A, E>(
  layer: Layer.Layer<QuotaGate, never, FileSystem>,
  program: Effect.Effect<A, E, QuotaGate>
) =>
  Effect.runPromise(
    program.pipe(
      Effect.provide(layer),
      Effect.provide(BunFileSystem.layer),
      Effect.provide(TestClock.layer())
    )
  );

const fixedReader = (value: ProviderUsage) => () => Effect.succeed(value);

describe("QuotaGate.admit", () => {
  test("a gate that is switched off admits a provider that is out", async () => {
    await run(
      gateLayer({
        enabled: false,
        readers: { codex: fixedReader(usage({ limitReached: true })) },
      }),
      Effect.gen(function* () {
        const gate = yield* QuotaGate;
        const decision = yield* gate.admit({ inflight: 0, provider: "codex" });
        expect(decision.defer).toBe(false);
      })
    );
  });

  test("a healthy read admits", async () => {
    await run(
      gateLayer({
        readers: {
          codex: fixedReader(
            usage({
              primary: {
                resetsAtMs: 1,
                utilizationPercent: 10,
                windowSeconds: null,
              },
            })
          ),
        },
      }),
      Effect.gen(function* () {
        const gate = yield* QuotaGate;
        expect(
          (yield* gate.admit({ inflight: 0, provider: "codex" })).defer
        ).toBe(false);
      })
    );
  });

  test("the short window defers quietly and carries its reset", async () => {
    await run(
      gateLayer({
        readers: {
          codex: fixedReader(
            usage({
              primary: {
                resetsAtMs: 1234,
                utilizationPercent: 85,
                windowSeconds: null,
              },
            })
          ),
        },
      }),
      Effect.gen(function* () {
        const gate = yield* QuotaGate;
        const decision = yield* gate.admit({ inflight: 0, provider: "codex" });
        expect(decision.defer).toBe(true);
        if (decision.defer) {
          expect(decision.window).toBe("primary");
          expect(decision.loud).toBe(false);
          expect(decision.resumesAtMs).toBe(1234);
        }
      })
    );
  });

  test("the long window is the loud one, because it idles for days", async () => {
    await run(
      gateLayer({
        readers: {
          codex: fixedReader(
            usage({
              secondary: {
                resetsAtMs: 9999,
                utilizationPercent: 90,
                windowSeconds: null,
              },
            })
          ),
        },
      }),
      Effect.gen(function* () {
        const gate = yield* QuotaGate;
        const decision = yield* gate.admit({ inflight: 0, provider: "codex" });
        expect(decision.defer).toBe(true);
        if (decision.defer) {
          expect(decision.window).toBe("secondary");
          expect(decision.loud).toBe(true);
        }
      })
    );
  });

  test("a stated limit defers whatever the percentages say", async () => {
    await run(
      gateLayer({
        readers: {
          codex: fixedReader(
            usage({ limitReached: true, reachedWindow: "secondary" })
          ),
        },
      }),
      Effect.gen(function* () {
        const gate = yield* QuotaGate;
        const decision = yield* gate.admit({ inflight: 0, provider: "codex" });
        expect(decision.defer).toBe(true);
        if (decision.defer) {
          expect(decision.window).toBe("secondary");
        }
      })
    );
  });

  test("an unreadable signal fails open — the whole point of `available`", async () => {
    await run(
      gateLayer({
        readers: { codex: fixedReader(usage({ available: false })) },
      }),
      Effect.gen(function* () {
        const gate = yield* QuotaGate;
        expect(
          (yield* gate.admit({ inflight: 0, provider: "codex" })).defer
        ).toBe(false);
      })
    );
  });

  test("in-flight headroom tips a window a stale cache would have admitted", async () => {
    await run(
      gateLayer({
        readers: {
          codex: fixedReader(
            usage({
              primary: {
                resetsAtMs: 1,
                utilizationPercent: 72,
                windowSeconds: null,
              },
            })
          ),
        },
      }),
      Effect.gen(function* () {
        const gate = yield* QuotaGate;
        expect(
          (yield* gate.admit({ inflight: 0, provider: "codex" })).defer
        ).toBe(false);
        expect(
          (yield* gate.admit({ inflight: 2, provider: "codex" })).defer
        ).toBe(true);
      })
    );
  });
});

describe("QuotaGate caching", () => {
  test("one read per poll interval, however many tasks ask", async () => {
    let reads = 0;
    await run(
      gateLayer({
        readers: {
          codex: () => {
            reads += 1;
            return Effect.succeed(usage());
          },
        },
      }),
      Effect.gen(function* () {
        const gate = yield* QuotaGate;
        yield* gate.admit({ inflight: 0, provider: "codex" });
        yield* gate.admit({ inflight: 0, provider: "codex" });
        expect(reads).toBe(1);
        yield* TestClock.adjust(BASE.pollIntervalMs + 1);
        yield* gate.admit({ inflight: 0, provider: "codex" });
        expect(reads).toBe(2);
      })
    );
  });

  test("describe answers off the cache and takes no read", async () => {
    let reads = 0;
    await run(
      gateLayer({
        readers: {
          codex: () => {
            reads += 1;
            return Effect.succeed(
              usage({
                secondary: {
                  resetsAtMs: 7,
                  utilizationPercent: 95,
                  windowSeconds: null,
                },
              })
            );
          },
        },
      }),
      Effect.gen(function* () {
        const gate = yield* QuotaGate;
        yield* gate.admit({ inflight: 0, provider: "codex" });
        const decision = yield* gate.describe({
          inflight: 0,
          provider: "codex",
        });
        expect(reads).toBe(1);
        expect(decision.defer).toBe(true);
      })
    );
  });
});

describe("QuotaGate reactive floor", () => {
  test("a drained-run error pauses, then resumes once the cooldown is out", async () => {
    await run(
      gateLayer({ readers: { codex: fixedReader(usage()) } }),
      Effect.gen(function* () {
        const gate = yield* QuotaGate;
        const tripped = yield* gate.noteError({
          message: "You've hit your usage limit",
          provider: "codex",
        });
        expect(tripped).toBe(true);
        const paused = yield* gate.admit({ inflight: 0, provider: "codex" });
        expect(paused.defer).toBe(true);
        if (paused.defer) {
          expect(paused.window).toBe("reactive");
        }
        yield* TestClock.adjust(BASE.cooldownMs + 1);
        expect(
          (yield* gate.admit({ inflight: 0, provider: "codex" })).defer
        ).toBe(false);
      })
    );
  });

  test("an unrelated failure pauses nothing", async () => {
    await run(
      gateLayer({ readers: { codex: fixedReader(usage()) } }),
      Effect.gen(function* () {
        const gate = yield* QuotaGate;
        expect(
          yield* gate.noteError({
            message: "ENOENT: no such file",
            provider: "codex",
          })
        ).toBe(false);
        expect(
          (yield* gate.admit({ inflight: 0, provider: "codex" })).defer
        ).toBe(false);
      })
    );
  });

  test("the structured reading pauses on a refusal and not on a warning", async () => {
    await run(
      gateLayer({ readers: { claude: fixedReader(usage()) } }),
      Effect.gen(function* () {
        const gate = yield* QuotaGate;
        expect(
          yield* gate.noteRateLimit({
            provider: "claude",
            status: "allowed_warning",
          })
        ).toBe(false);
        expect(
          (yield* gate.admit({ inflight: 0, provider: "claude" })).defer
        ).toBe(false);
        expect(
          yield* gate.noteRateLimit({ provider: "claude", status: "rejected" })
        ).toBe(true);
        expect(
          (yield* gate.admit({ inflight: 0, provider: "claude" })).defer
        ).toBe(true);
      })
    );
  });

  test("the cooldown doubles on a re-trip rather than probing at the same rate", async () => {
    await run(
      gateLayer({ readers: { codex: fixedReader(usage()) } }),
      Effect.gen(function* () {
        const gate = yield* QuotaGate;
        yield* gate.noteError({
          message: "usage limit reached",
          provider: "codex",
        });
        yield* TestClock.adjust(BASE.cooldownMs + 1);
        yield* gate.noteError({
          message: "usage limit reached",
          provider: "codex",
        });
        // One cooldown later the second pause is still in force: it is twice as
        // long as the first.
        yield* TestClock.adjust(BASE.cooldownMs + 1);
        expect(
          (yield* gate.admit({ inflight: 0, provider: "codex" })).defer
        ).toBe(true);
      })
    );
  });

  test("a trip long after the last one starts the ladder again", async () => {
    await run(
      gateLayer({ readers: { codex: fixedReader(usage()) } }),
      Effect.gen(function* () {
        const gate = yield* QuotaGate;
        yield* gate.noteError({
          message: "usage limit reached",
          provider: "codex",
        });
        // Two cooldowns of quiet: the drain ended, so this is a new one.
        yield* TestClock.adjust(BASE.cooldownMs * 3);
        yield* gate.noteError({
          message: "usage limit reached",
          provider: "codex",
        });
        yield* TestClock.adjust(BASE.cooldownMs + 1);
        expect(
          (yield* gate.admit({ inflight: 0, provider: "codex" })).defer
        ).toBe(false);
      })
    );
  });

  test("the pause survives a restart, so a fresh loop does not burst into a drain", async () => {
    const directory = stateDir();
    const options = {
      readers: { codex: fixedReader(usage()) },
      stateDir: directory,
    };
    await run(
      QuotaGate.layer({ ...BASE, ...options }),
      Effect.gen(function* () {
        const gate = yield* QuotaGate;
        yield* gate.noteError({
          message: "rate limit exceeded",
          provider: "codex",
        });
      })
    );
    await run(
      QuotaGate.layer({ ...BASE, ...options }),
      Effect.gen(function* () {
        const gate = yield* QuotaGate;
        expect(
          (yield* gate.admit({ inflight: 0, provider: "codex" })).defer
        ).toBe(true);
      })
    );
  });
});

describe("QuotaGate isolation", () => {
  test("a drained Claude leaves Codex dispatching", async () => {
    await run(
      gateLayer({
        readers: {
          claude: fixedReader(
            usage({ limitReached: true, reachedWindow: "secondary" })
          ),
          codex: fixedReader(usage()),
        },
      }),
      Effect.gen(function* () {
        const gate = yield* QuotaGate;
        expect(
          (yield* gate.admit({ inflight: 0, provider: "claude" })).defer
        ).toBe(true);
        expect(
          (yield* gate.admit({ inflight: 0, provider: "codex" })).defer
        ).toBe(false);
      })
    );
  });

  test("a reactive pause on one provider leaves the other alone", async () => {
    await run(
      gateLayer({
        readers: {
          claude: fixedReader(usage()),
          codex: fixedReader(usage()),
        },
      }),
      Effect.gen(function* () {
        const gate = yield* QuotaGate;
        yield* gate.noteRateLimit({ provider: "claude", status: "rejected" });
        expect(
          (yield* gate.admit({ inflight: 0, provider: "claude" })).defer
        ).toBe(true);
        expect(
          (yield* gate.admit({ inflight: 0, provider: "codex" })).defer
        ).toBe(false);
      })
    );
  });

  test("a provider outside the governed set always admits", async () => {
    await run(
      gateLayer({
        providers: ["codex"],
        readers: { codex: fixedReader(usage({ limitReached: true })) },
      }),
      Effect.gen(function* () {
        const gate = yield* QuotaGate;
        expect(
          (yield* gate.admit({ inflight: 0, provider: "claude" })).defer
        ).toBe(false);
        expect(
          (yield* gate.admit({ inflight: 0, provider: "codex" })).defer
        ).toBe(true);
      })
    );
  });
});

describe("QuotaGate observing without enforcing", () => {
  test("a drained provider dispatches when the reading is not enforced", async () => {
    await run(
      gateLayer({
        proactive: false,
        readers: {
          claude: fixedReader(usage()),
          codex: fixedReader(usage({ limitReached: true })),
        },
      }),
      Effect.gen(function* () {
        const gate = yield* QuotaGate;
        expect(
          (yield* gate.admit({ inflight: 0, provider: "codex" })).defer
        ).toBe(false);
      })
    );
  });

  test("the numbers are still read and still published", async () => {
    const directory = stateDir();
    await run(
      QuotaGate.layer({
        ...BASE,
        proactive: false,
        readers: {
          claude: fixedReader(usage()),
          codex: fixedReader(
            usage({
              primary: {
                resetsAtMs: 5000,
                utilizationPercent: 96,
                windowSeconds: 18_000,
              },
            })
          ),
        },
        stateDir: directory,
      }),
      Effect.gen(function* () {
        const gate = yield* QuotaGate;
        yield* gate.refresh();
        const snapshot = yield* gate.snapshot;
        const codex = snapshot.providers.find(
          (entry) => entry.provider === "codex"
        );
        expect(codex?.state).toBe("ok");
        expect(codex?.enforced).toBe(false);
        expect(codex?.windows[0]?.remainingPercent).toBe(4);
      })
    );
  });

  test("a reactive pause still holds, whatever the proactive switch says", async () => {
    await run(
      gateLayer({
        proactive: false,
        readers: {
          claude: fixedReader(usage()),
          codex: fixedReader(usage()),
        },
      }),
      Effect.gen(function* () {
        const gate = yield* QuotaGate;
        yield* gate.noteRateLimit({ provider: "codex", status: "rejected" });
        expect(
          (yield* gate.admit({ inflight: 0, provider: "codex" })).defer
        ).toBe(true);
      })
    );
  });

  test("reads switched off leave nothing to publish but say why", async () => {
    await run(
      gateLayer({ read: false }),
      Effect.gen(function* () {
        const gate = yield* QuotaGate;
        yield* gate.refresh();
        const snapshot = yield* gate.snapshot;
        for (const report of snapshot.providers) {
          expect(report.state).toBe("unavailable");
          expect(report.note).toBe("usage reads are switched off");
          expect(report.windows).toHaveLength(0);
        }
      })
    );
  });
});

describe("QuotaGate.refresh", () => {
  test("leaves a reading on disk for the gateway, on an idle board", async () => {
    const directory = stateDir();
    await run(
      QuotaGate.layer({
        ...BASE,
        readers: {
          claude: fixedReader(usage()),
          codex: fixedReader(usage()),
        },
        stateDir: directory,
      }),
      Effect.gen(function* () {
        const gate = yield* QuotaGate;
        yield* gate.refresh();
        const fs = yield* FileSystem;
        const decoded = yield* Schema.decodeUnknownEffect(
          ProviderUsageSnapshot
        )(JSON.parse(yield* fs.readFileString(join(directory, "usage.json"))));
        expect(decoded.providers.map((entry) => entry.provider)).toEqual([
          "claude",
          "codex",
        ]);
        expect(decoded.providers[0]?.windows[0]?.label).toBe("5h");
        expect(decoded.providers[0]?.windows[1]?.label).toBe("7d");
      }).pipe(Effect.provide(BunFileSystem.layer))
    );
  });

  test("polls no more often than a dispatch would", async () => {
    let reads = 0;
    await run(
      gateLayer({
        readers: {
          claude: fixedReader(usage()),
          codex: () => {
            reads += 1;
            return Effect.succeed(usage());
          },
        },
      }),
      Effect.gen(function* () {
        const gate = yield* QuotaGate;
        yield* gate.refresh();
        yield* gate.refresh();
        yield* gate.admit({ inflight: 0, provider: "codex" });
        expect(reads).toBe(1);
      })
    );
  });

  test("a paused provider is not polled while the cooldown runs", async () => {
    let reads = 0;
    await run(
      gateLayer({
        readers: {
          claude: fixedReader(usage()),
          codex: () => {
            reads += 1;
            return Effect.succeed(usage());
          },
        },
      }),
      Effect.gen(function* () {
        const gate = yield* QuotaGate;
        yield* gate.noteRateLimit({ provider: "codex", status: "rejected" });
        yield* gate.refresh();
        expect(reads).toBe(0);
        const snapshot = yield* gate.snapshot;
        const codex = snapshot.providers.find(
          (entry) => entry.provider === "codex"
        );
        expect(codex?.state).toBe("paused");
        expect(codex?.pausedUntil).not.toBeNull();
      })
    );
  });
});

describe("QuotaGate.announceOnce", () => {
  test("says it once per subject per drain, and again after a resume", async () => {
    await run(
      gateLayer({ readers: { codex: fixedReader(usage()) } }),
      Effect.gen(function* () {
        const gate = yield* QuotaGate;
        yield* gate.noteError({
          message: "usage limit reached",
          provider: "codex",
        });
        const announce = (subjectKey: string) =>
          gate.announceOnce({ provider: "codex", subjectKey });
        expect(yield* announce("task:a")).toBe(true);
        expect(yield* announce("task:a")).toBe(false);
        // A conversation is a subject like any other, and a drained provider
        // defers it for the same reason it defers a card.
        expect(yield* announce("thread:a")).toBe(true);
        yield* TestClock.adjust(BASE.cooldownMs + 1);
        yield* gate.admit({ inflight: 0, provider: "codex" });
        expect(yield* announce("task:a")).toBe(true);
      })
    );
  });
});
