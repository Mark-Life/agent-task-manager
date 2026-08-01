import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BunFileSystem } from "@effect/platform-bun";
import { ConfigProvider, Effect, Layer } from "effect";
import { EventLog } from "./event-log";

const SERVICE = "ledger-test";

let directory: string;

beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), "event-log-"));
});

afterEach(() => {
  rmSync(directory, { force: true, recursive: true });
});

const run = <A>(
  program: Effect.Effect<A, unknown, EventLog>,
  options: { readonly maxBytes?: number } = {}
) =>
  Effect.runPromise(
    program.pipe(
      Effect.provide(
        EventLog.layer({
          maxBytes: options.maxBytes,
          serviceName: SERVICE,
        }).pipe(
          Layer.provide(
            Layer.mergeAll(
              BunFileSystem.layer,
              ConfigProvider.layer(
                ConfigProvider.fromUnknown({ EVENT_LOG_DIR: directory })
              )
            )
          )
        )
      )
    )
  );

const appendMany = (count: number) =>
  Effect.gen(function* () {
    const log = yield* EventLog;
    for (let index = 0; index < count; index += 1) {
      yield* log.append({ event: "atm.test", index });
    }
    return log.path;
  });

const lineCount = (path: string) =>
  readFileSync(path, "utf-8")
    .split("\n")
    .filter((line) => line.trim().length > 0).length;

describe("EventLog", () => {
  test("appends one line per record under the configured directory", async () => {
    const path = await run(appendMany(3));

    expect(path).toBe(join(directory, `${SERVICE}.jsonl`));
    expect(lineCount(path)).toBe(3);
  });

  test("creates the parent directory on demand", async () => {
    const nested = join(directory, "deep", "deeper");
    rmSync(directory, { force: true, recursive: true });
    directory = nested;

    const path = await run(appendMany(1));

    expect(existsSync(path)).toBe(true);
  });

  test("rotates one generation once the size cap is passed", async () => {
    const path = await run(appendMany(6), { maxBytes: 100 });

    // Rotation is a rename, so the live file holds only what followed it.
    expect(existsSync(join(directory, `${SERVICE}.1.jsonl`))).toBe(true);
    expect(lineCount(path)).toBeLessThan(6);
    expect(
      lineCount(path) + lineCount(join(directory, `${SERVICE}.1.jsonl`))
    ).toBe(6);
  });
});
