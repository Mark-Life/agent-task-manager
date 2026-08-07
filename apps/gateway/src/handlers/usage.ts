/**
 * Remaining provider allowance: a file read, and deliberately nothing more.
 *
 * The numbers belong to the loop. It holds the provider credentials, it already
 * caches a reading in front of dispatch, and it publishes that reading under the
 * data root on every sweep. This serves the file — so what a person sees and
 * what the gate decided are one reading, and nobody's dashboard refresh spends a
 * token or races the poller for the same window.
 *
 * Every failure here answers "nothing has been published". A gateway that 500s
 * because a JSON file is half-written, or that returns a 404 an operator has to
 * interpret, is a worse answer than an empty snapshot that says plainly nothing
 * has looked yet — which is also the honest reading when the loop is down, and
 * the loop being down is exactly when somebody is looking at this page.
 *
 * A missing file is normal and silent; a file that is there and will not decode
 * is not, and it warns, because that is the shape of the loop and the gateway
 * having drifted apart.
 */

import { join } from "node:path";
import { Api } from "@workspace/api";
import {
  EMPTY_USAGE_SNAPSHOT,
  PROVIDER_USAGE_FILE,
  ProviderUsageSnapshot,
  QUOTA_SEGMENT,
} from "@workspace/domain";
import { Config, Effect, Schema } from "effect";
import { FileSystem } from "effect/FileSystem";
import { HttpApiBuilder } from "effect/unstable/httpapi";
import { atBuild } from "./at-build";

/** Mirrors the default every other reader of `DATA_ROOT` applies. */
const DEFAULT_DATA_ROOT = ".data";

const dataRootConfig = Config.string("DATA_ROOT").pipe(
  Config.withDefault(DEFAULT_DATA_ROOT)
);

const decodeSnapshot = Schema.decodeUnknownEffect(ProviderUsageSnapshot);

/** Where the loop leaves its reading. One spelling, shared through the domain. */
export const publishedUsagePathOf = (dataRoot: string) =>
  join(dataRoot, QUOTA_SEGMENT, PROVIDER_USAGE_FILE);

/**
 * The last published reading, or the empty snapshot.
 *
 * Exported so it can be tested against a real file rather than through a
 * request: what can be wrong here is the path, the decode and the degradation,
 * and none of the three needs a server or a database to be wrong in.
 */
export const readPublishedUsage = (dataRoot: string) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem;
    const path = publishedUsagePathOf(dataRoot);
    const present = yield* fs
      .exists(path)
      .pipe(Effect.orElseSucceed(() => false));
    if (!present) {
      return EMPTY_USAGE_SNAPSHOT;
    }
    const text = yield* fs.readFileString(path);
    return yield* decodeSnapshot(JSON.parse(text));
  }).pipe(
    Effect.catchCause((cause) =>
      Effect.logWarning(
        `usage: the published reading at ${publishedUsagePathOf(dataRoot)} could not be read`,
        cause
      ).pipe(Effect.as(EMPTY_USAGE_SNAPSHOT))
    )
  );

/** The `usage` group: what is left in the tanks, as the loop last read it. */
export const usageHandlers = HttpApiBuilder.group(Api, "usage", (handlers) =>
  Effect.gen(function* () {
    // At build time, for the same reason the artifact handlers do it: a
    // mistyped DATA_ROOT should stop the process, not answer a request.
    const dataRoot = yield* Effect.orDie(dataRootConfig);
    const on = yield* atBuild<FileSystem>();

    return handlers.handle("get", () => on(readPublishedUsage(dataRoot)));
  })
);
