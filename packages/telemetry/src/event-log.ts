import { join } from "node:path";
import { Config, Context, Effect, Layer, Option } from "effect";
import { FileSystem } from "effect/FileSystem";
import type { PlatformError } from "effect/PlatformError";

/**
 * Size cap for one ledger file, in bytes.
 *
 * Volume assumption: a single-operator system does on the order of a few
 * hundred units of work a day, and one wide event encodes to roughly 1 KB, so
 * the ledger grows by a few hundred KB a day. 64 MiB is therefore several
 * months of history in the live file and years across the two generations kept.
 * Sampling stays off at this volume: every event is kept. Revisit the cap and
 * the retention window if daily volume rises about tenfold.
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
