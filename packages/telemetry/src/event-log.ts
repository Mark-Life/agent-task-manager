import { join } from "node:path";
import { Config, Context, Effect, Layer, Option } from "effect";
import { FileSystem } from "effect/FileSystem";
import type { PlatformError } from "effect/PlatformError";

/**
 * Size cap for one ledger file, in bytes.
 *
 * The volume this assumed — a few hundred units of work a day at roughly 1 KB
 * each, so several months in the live file — was wrong about which unit of work
 * dominates. Measured over the gateway's first 15,695 rows: 2,569 rows/day at
 * 772 B/row, of which 69.7% were `/tasks/:taskId` and `/tasks/board` answered in
 * a couple of dozen milliseconds for a dashboard nobody was watching. That is
 * roughly two megabytes a day and a turnover of 34 days, ten times faster than
 * this comment used to claim, which is exactly the trigger it named.
 *
 * The answer was to thin the traffic rather than to raise the cap: the gateway
 * now tail-samples its own marker in `apps/gateway/src/request-sampling.ts`,
 * keeping every failure, every stream and every request above its route's p99,
 * and one in twenty of the rest under a `sampleRate` that says what each stands
 * for. That is on the order of 160 rows and 124 KB a day from the gateway, so
 * 64 MiB is again more than a year in the live file and years across the two
 * generations kept.
 *
 * Every other marker is unsampled and stays that way: a run, a turn, a sandbox
 * and a chat are units of work a person asked for, they are counted in the
 * hundreds a day, and each one is worth a row. Revisit this the day a second
 * marker needs a predicate.
 */
export const MAX_LEDGER_BYTES = 67_108_864;

/**
 * Rotation: before each append, the live file's size is checked. At or above
 * {@link MAX_LEDGER_BYTES} it is renamed to `<service>.1.jsonl`, replacing the
 * previous generation, and a fresh live file starts. One generation is kept, so
 * disk use is bounded at roughly twice the cap per service. Rotation is a
 * rename, so a reader holding the old file descriptor keeps reading it.
 */
const rotatedSuffix = ".1.jsonl";

/** Default root for on-disk state when `DATA_ROOT` is unset. */
const DEFAULT_DATA_ROOT = ".data";

const eventLogDirectoryConfig = Effect.gen(function* () {
  const configured = yield* Config.option(Config.string("EVENT_LOG_DIR"));
  if (Option.isSome(configured)) {
    return configured.value;
  }
  const dataRoot = yield* Config.string("DATA_ROOT").pipe(
    Config.withDefault(DEFAULT_DATA_ROOT)
  );
  return join(dataRoot, "events");
});

/** One append-only JSONL ledger, one file per service. */
export interface EventLogInterface {
  /** Appends exactly one JSON line, creating the parent directory on demand. */
  readonly append: (
    record: Readonly<Record<string, unknown>>
  ) => Effect.Effect<void, PlatformError>;
  /** Absolute or relative path of the live ledger file. */
  readonly path: string;
}

/** Options for {@link EventLog.layer}. */
export interface EventLogOptions {
  /** Rotation threshold. Defaults to {@link MAX_LEDGER_BYTES}. */
  readonly maxBytes?: number;
  /** Names the ledger file: `<serviceName>.jsonl`. */
  readonly serviceName: string;
}

const make = (options: EventLogOptions) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem;
    const directory = yield* eventLogDirectoryConfig;
    const path = join(directory, `${options.serviceName}.jsonl`);
    const rotatedPath = join(
      directory,
      `${options.serviceName}${rotatedSuffix}`
    );

    const maxBytes = options.maxBytes ?? MAX_LEDGER_BYTES;

    const rotateWhenFull = Effect.gen(function* () {
      const info = yield* Effect.option(fs.stat(path));
      if (Option.isNone(info) || info.value.size < maxBytes) {
        return;
      }
      yield* fs.rename(path, rotatedPath);
    });

    const append = (record: Readonly<Record<string, unknown>>) =>
      Effect.gen(function* () {
        const line = `${JSON.stringify(record)}\n`;
        yield* fs.makeDirectory(directory, { recursive: true });
        yield* rotateWhenFull;
        yield* fs.writeFileString(path, line, { flag: "a" });
      });

    return EventLog.of({ append, path });
  });

/**
 * The durable ledger. Always on: it is the record that survives a backend
 * outage, an unset OTLP endpoint, and a quieted logger.
 */
export class EventLog extends Context.Service<EventLog, EventLogInterface>()(
  "@workspace/telemetry/EventLog"
) {
  static readonly layer = (options: EventLogOptions) =>
    Layer.effect(EventLog, make(options));
}
