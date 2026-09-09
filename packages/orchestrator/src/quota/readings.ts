/**
 * The last reading that produced a signal, per provider, kept across restarts.
 *
 * The gate's cache answers "what did the last *attempt* say", which is what a
 * dispatch decision needs and which is deliberately allowed to be nothing: an
 * unreadable provider dispatches. But a panel fed off that cache forgets. One
 * failed poll — a rotated token, a 502, the loop restarting — replaced figures
 * an operator was reading with "no signal", and the age beside it started
 * pointing at the failed attempt rather than at the last real reading.
 *
 * So the good readings are kept separately and written down. Two properties
 * follow, and both are the point:
 *
 * **A failed read never erases figures.** The store only ever advances on a
 * reading that carried a signal, so what the panel shows is the last thing a
 * provider actually said, stale-dated with when it said it. "No signal" goes
 * back to meaning what it says: this provider has never been read.
 *
 * **A restart does not blank the board.** The published document is rewritten by
 * the next sweep whatever that sweep found, so memory alone lost the numbers the
 * moment the loop bounced. This file is beside the pause record for the same
 * reason that one is a file: the state outlives the process that holds it.
 *
 * What is *not* here is the decision. Nothing in this store feeds
 * {@link ProviderUsage} back into the gate, because a three-day-old "97% spent"
 * would hold a healthy pool closed for three days. Stale figures are for reading;
 * only a live one gates.
 */

import { join } from "node:path";
import type { SessionProvider } from "@workspace/domain";
import { Effect, Schema } from "effect";
import type { FileSystem } from "effect/FileSystem";
import { ProviderUsage } from "./types";

/** Where the good readings live, beside the pause record under the state dir. */
const READINGS_FILE = "readings.json";

/**
 * One reading and the moment it was taken. The timestamp is the whole reason
 * this is stored rather than recomputed: it is what "read 3 days ago" is read
 * off, and a reading with no age behind it looks live when it is not.
 */
export const StoredReading = Schema.Struct({
  atMs: Schema.Number,
  usage: ProviderUsage,
}).annotate({ identifier: "StoredReading" });

export interface StoredReading
  extends Schema.Schema.Type<typeof StoredReading> {}

/**
 * The file's contents: provider to its last good reading, absent meaning this
 * provider has never been read. A record rather than an array so a provider
 * arriving or leaving `GATED_PROVIDERS` costs nothing to read back.
 */
export const StoredReadings = Schema.Record(
  Schema.String,
  StoredReading
).annotate({ identifier: "StoredReadings" });

export type StoredReadings = typeof StoredReadings.Type;

const decodeReadings = Schema.decodeUnknownEffect(StoredReadings);
const encodeReadings = Schema.encodeEffect(StoredReadings);

/** Where the loop keeps the good readings. */
export const readingsPathOf = (stateDir: string) =>
  join(stateDir, READINGS_FILE);

/**
 * The stored readings, or an empty map on anything at all.
 *
 * Decoded rather than cast, unlike the pause record next to it, because this
 * file carries percentages that end up drawn as bars. A truncated write or a
 * shape from an older release has to read as "nothing stored" — which shows the
 * honest blank — rather than as a window at `NaN%`.
 */
export const readStoredReadings = (input: {
  readonly fs: FileSystem;
  readonly stateDir: string;
}) =>
  input.fs.readFileString(readingsPathOf(input.stateDir)).pipe(
    Effect.flatMap((text) => decodeReadings(JSON.parse(text))),
    Effect.catchCause(() => Effect.succeed({} as StoredReadings))
  );

/**
 * Writes the map through a temporary file, for the reason every other writer
 * under the state directory does: a crash mid-write must leave the previous
 * readings rather than a truncated file that reads as "never read".
 *
 * Best effort by construction. A dashboard that shows an older figure than it
 * could have is a degraded dashboard; a dispatch that failed because a file
 * about the dispatch would not write would be a broken factory.
 */
export const writeStoredReadings = (input: {
  readonly fs: FileSystem;
  readonly readings: StoredReadings;
  readonly stateDir: string;
}) =>
  Effect.gen(function* () {
    const encoded = yield* encodeReadings(input.readings);
    const path = readingsPathOf(input.stateDir);
    yield* input.fs.makeDirectory(input.stateDir, { recursive: true });
    const temporary = `${path}.${process.pid}.tmp`;
    yield* input.fs.writeFileString(
      temporary,
      JSON.stringify(encoded, null, 2)
    );
    yield* input.fs.rename(temporary, path);
  }).pipe(Effect.ignoreCause);

/** One provider's stored reading, or null where it has never been read. */
export const storedReadingOf = (
  readings: StoredReadings,
  provider: SessionProvider
): StoredReading | null => readings[provider] ?? null;
