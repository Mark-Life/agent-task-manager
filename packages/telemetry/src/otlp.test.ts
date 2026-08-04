import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BunFileSystem } from "@effect/platform-bun";
import { serve } from "bun";
import { ConfigProvider, Effect, Layer, References, Schema } from "effect";
import { defineEvent, outcomeField } from "./event";
import { parseOtlpHeaders } from "./otlp";
import { observabilityLayer, telemetryLayer } from "./runtime";
import { emitEvent } from "./telemetry";

describe("parseOtlpHeaders", () => {
  test("parses a single header", () => {
    expect(parseOtlpHeaders("X-Axiom-Dataset=atm")).toEqual({
      "X-Axiom-Dataset": "atm",
    });
  });

  test("parses multiple comma-separated headers", () => {
    expect(
      parseOtlpHeaders("Authorization=Bearer xaat-abc,X-Axiom-Dataset=atm")
    ).toEqual({
      Authorization: "Bearer xaat-abc",
      "X-Axiom-Dataset": "atm",
    });
  });

  test("splits on the FIRST '=' so values may contain '='", () => {
    expect(parseOtlpHeaders("Authorization=Bearer abc=def==")).toEqual({
      Authorization: "Bearer abc=def==",
    });
  });

  test("trims whitespace around keys and values", () => {
    expect(parseOtlpHeaders("  A = b  ,  C =d ")).toEqual({ A: "b", C: "d" });
  });

  test("skips blank and malformed (no '=') entries", () => {
    expect(parseOtlpHeaders("A=1,,   ,no-equals,B=2")).toEqual({
      A: "1",
      B: "2",
    });
  });

  test("empty input yields an empty record", () => {
    expect(parseOtlpHeaders("")).toEqual({});
    expect(parseOtlpHeaders("   ")).toEqual({});
  });

  test("an empty value is preserved (key present, value '')", () => {
    expect(parseOtlpHeaders("A=")).toEqual({ A: "" });
  });
});

describe("observabilityLayer", () => {
  test("builds with the endpoint unset and makes no fetch call", async () => {
    const original = globalThis.fetch;
    let calls = 0;
    globalThis.fetch = ((...args: Parameters<typeof fetch>) => {
      calls += 1;
      return original(...args);
    }) as typeof fetch;
    try {
      await Effect.runPromise(
        Effect.scoped(
          Layer.build(
            observabilityLayer({ serviceName: "telemetry-test" }).pipe(
              Layer.provide(
                ConfigProvider.layer(ConfigProvider.fromUnknown({}))
              )
            )
          )
        )
      );
    } finally {
      globalThis.fetch = original;
    }
    expect(calls).toBe(0);
  });

  test("installs the console logger alone when the endpoint is unset", async () => {
    expect(await loggerCount({})).toBe(1);
  });

  test("installs the console logger and the OTLP logger when the endpoint is set", async () => {
    // Ordering is load-bearing: were the OTLP logger to win the merge, console
    // output would survive but nothing would reach the collector, with a green
    // suite either way.
    expect(
      await loggerCount({
        OTEL_EXPORTER_OTLP_ENDPOINT: "http://127.0.0.1:1",
      })
    ).toBe(2);
  });
});

/** Number of log sinks the observability layer installs under `env`. */
const loggerCount = (env: Record<string, string>) =>
  Effect.runPromise(
    Effect.gen(function* () {
      const loggers = yield* References.CurrentLoggers;
      return loggers.size;
    }).pipe(
      Effect.provide(
        observabilityLayer({ serviceName: "telemetry-test" }).pipe(
          Layer.provide(ConfigProvider.layer(ConfigProvider.fromUnknown(env)))
        )
      )
    )
  );

const OtlpTestEvent = defineEvent("atm.otlp-test", {
  outcome: outcomeField([]),
  provider: Schema.String,
});

/** One OTLP request as the receiver saw it. */
interface Captured {
  readonly body: unknown;
  readonly path: string;
}

/** Every attribute key/value pair anywhere in an OTLP payload, flattened. */
const attributesIn = (payload: unknown) => {
  const found: Record<string, unknown> = {};
  const visit = (node: unknown) => {
    if (Array.isArray(node)) {
      for (const item of node) {
        visit(item);
      }
      return;
    }
    if (typeof node !== "object" || node === null) {
      return;
    }
    const key = Reflect.get(node, "key");
    const value = Reflect.get(node, "value");
    if (
      typeof key === "string" &&
      typeof value === "object" &&
      value !== null
    ) {
      found[key] = Object.values(value)[0];
    }
    for (const child of Object.values(node)) {
      visit(child);
    }
  };
  visit(payload);
  return found;
};

describe("OTLP export", () => {
  let directory: string;

  beforeEach(() => {
    directory = mkdtempSync(join(tmpdir(), "otlp-"));
  });

  afterEach(() => {
    rmSync(directory, { force: true, recursive: true });
  });

  test("exports the wide event, omitting null fields and stamping the version", async () => {
    const captured: Captured[] = [];
    const server = serve({
      fetch: async (request) => {
        captured.push({
          body: await request.json(),
          path: new URL(request.url).pathname,
        });
        return new Response("{}", { status: 200 });
      },
      port: 0,
    });

    try {
      await Effect.runPromise(
        emitEvent(OtlpTestEvent, {
          costUsd: null,
          durationMs: 5000,
          errorClass: null,
          errorMessage: null,
          outcome: "interrupted",
          phase: "end",
          provider: "claude",
          queueWaitMs: null,
          runId: "r-1",
          sessionId: null,
          spanId: null,
          taskId: "t-1",
          totalTokens: null,
          traceId: null,
          turns: null,
          workspaceId: "w-1",
        }).pipe(
          Effect.provide(
            telemetryLayer({ serviceName: "telemetry-test" }).pipe(
              Layer.provide(
                Layer.mergeAll(
                  BunFileSystem.layer,
                  ConfigProvider.layer(
                    ConfigProvider.fromUnknown({
                      EVENT_LOG_DIR: directory,
                      OTEL_EXPORTER_OTLP_ENDPOINT: server.url.origin,
                      SERVICE_VERSION: "9.9.9",
                    })
                  )
                )
              )
            )
          )
        )
      );
    } finally {
      server.stop(true);
    }

    const logs = captured.filter((request) => request.path === "/v1/logs");
    expect(logs.length).toBeGreaterThan(0);
    const attributes = attributesIn(logs.map((request) => request.body));

    // the event really reached the collector
    expect(attributes.event).toBe("atm.otlp-test");
    expect(attributes.runId).toBe("r-1");
    expect(attributes.outcome).toBe("interrupted");
    // a field that has a value keeps its type
    expect(attributes.durationMs).toBe(5000);

    // A null is absent, never the string "null". Were it exported as a string,
    // costUsd would be a number on a healthy row and a string on a degraded one,
    // and the column would stop aggregating in any backend that infers types.
    for (const key of [
      "costUsd",
      "queueWaitMs",
      "totalTokens",
      "traceId",
      "turns",
    ]) {
      expect(attributes).not.toHaveProperty(key);
    }

    // SERVICE_VERSION reaches the resource, so the collector and the ledger name
    // the same build without every application passing it by hand.
    expect(attributes["service.name"]).toBe("telemetry-test");
    expect(attributes["service.version"]).toBe("9.9.9");
  });
});
