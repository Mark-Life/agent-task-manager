#!/usr/bin/env bun

/**
 * Bundles the container's entrypoint to one file on the host.
 *
 * The image and the entrypoint move at different speeds, and that is the whole
 * reason this script exists. `atm.local/base` carries bun, node, git, `gh`,
 * ripgrep and the two agent CLIs — tooling rebuilt on a weekly schedule — while
 * the entrypoint is this repository's own code and changes with every commit.
 * Baking it into the image would mean a five-minute image build per commit,
 * which is a tax nobody pays and therefore a tax that gets skipped, leaving
 * containers running last week's harness. So the entrypoint is bundled here and
 * bind-mounted read-only at `CONTAINER_ENTRYPOINT_PATH`: one file, one mount,
 * rebuilt in under a second.
 *
 * **`--target=bun`, not `--compile`, and the reason is measured.** Both forms
 * were built and both were run inside `atm.local/base:latest`. The compiled
 * executable is 96 MB, has to be cross-compiled for `bun-linux-arm64`, and is
 * rewritten into the data root on every commit; the plain bundle is 2.8 MB
 * built in about 50ms, run by the bun the image already pins to the version
 * this repository's `packageManager` names. Both run the same turns to the same
 * exit codes, and neither changes what the Claude Agent SDK resolves at runtime
 * — it looks its native CLI up through `createRequire(import.meta.url)`, which
 * finds no `node_modules` beside a mounted file in either form. So the deciding
 * factors are size, build time, and a bundle a human can open on the host when
 * a container misbehaves.
 *
 * Usage:
 *
 *   bun run entrypoint:build            bundle it
 *   bun run entrypoint:build --check    whether it is there and how old; builds nothing
 *
 * The output path comes from `@workspace/harness` rather than from a string
 * here, because the orchestrator mounts what this writes: a second spelling is
 * a container that starts with no entrypoint and dies on its first instruction.
 */

import { readdirSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import process from "node:process";
import { BunRuntime } from "@effect/platform-bun";
import * as BunChildProcessSpawner from "@effect/platform-bun/BunChildProcessSpawner";
import * as BunFileSystem from "@effect/platform-bun/BunFileSystem";
import * as BunPath from "@effect/platform-bun/BunPath";
import { entrypointBundlePathOf } from "@workspace/harness";
import { Config, Effect, Layer, Option, Schema, Stream } from "effect";
import { FileSystem } from "effect/FileSystem";
import * as ChildProcess from "effect/unstable/process/ChildProcess";
import { ChildProcessSpawner } from "effect/unstable/process/ChildProcessSpawner";

/** The bundler. Resolved on PATH — this repository runs on bun everywhere. */
const BUN = "bun";

/** Where on-disk state lives when `DATA_ROOT` is unset, as the telemetry ledger has it. */
const DEFAULT_DATA_ROOT = ".data";

/** The executable that becomes the bundle. */
const ENTRY = new URL("../packages/harness/scripts/turn.ts", import.meta.url)
  .pathname;

/** Where the entrypoint's own sources live, for the staleness question below. */
const SOURCE_DIR = new URL("../packages/harness/src/", import.meta.url)
  .pathname;

const BYTES_PER_MB = 1_000_000;

const MS_PER_MINUTE = 60_000;

const MINUTES_PER_HOUR = 60;

/** Bun is not there, or would not run. */
class BundlerUnavailable extends Schema.TaggedErrorClass<BundlerUnavailable>()(
  "BuildEntrypoint.BundlerUnavailable",
  { detail: Schema.String }
) {}

/** The bundler ran and refused. Its output is already on the log above. */
class BundleFailed extends Schema.TaggedErrorClass<BundleFailed>()(
  "BuildEntrypoint.BundleFailed",
  { exitCode: Schema.Number, outFile: Schema.String }
) {}

/** Whether the invocation only wants a report. */
export const isCheckOnly = (argv: readonly string[]) =>
  argv.includes("--check");

/**
 * What one bundle asks bun to do. Pure, so the argv is assertable without
 * running a bundler.
 *
 * Not minified, deliberately. The bundle is read by nothing but bun and by a
 * human looking at a stack frame from a container that misbehaved, and the
 * megabyte minification saves is worth less than a frame that still names the
 * function it came from.
 */
export const bundleArgv = (outFile: string): readonly string[] => [
  "build",
  ENTRY,
  "--target=bun",
  "--outfile",
  outFile,
];

/**
 * Bun's process spawner and the two services it needs. Named rather than taken
 * from the aggregate platform layer, which would also claim this process's
 * stdin for a terminal it has no use for.
 */
const spawnerLayer = BunChildProcessSpawner.layer.pipe(
  Layer.provide(Layer.mergeAll(BunFileSystem.layer, BunPath.layer))
);

/** One bundler invocation, its output on the log as it arrives. */
const runBundler = Effect.fn("BuildEntrypoint.runBundler")(function* (
  args: readonly string[]
) {
  const spawner = yield* ChildProcessSpawner;
  const handle = yield* spawner.spawn(
    ChildProcess.make(BUN, [...args], { extendEnv: true })
  );
  yield* Stream.runForEach(
    Stream.splitLines(Stream.decodeText(handle.all)),
    (line) => (line.length === 0 ? Effect.void : Effect.logInfo(line))
  );
  return yield* handle.exitCode;
});

/** The bundle's path, under whatever data root this host is using. */
const bundlePath = Effect.gen(function* () {
  const dataRoot = yield* Config.string("DATA_ROOT").pipe(
    Config.withDefault(DEFAULT_DATA_ROOT)
  );
  return entrypointBundlePathOf(dataRoot);
});

/** Age in whole minutes, and in hours once it is old enough for that to read better. */
export const describeAge = (ageMs: number) => {
  const minutes = Math.floor(ageMs / MS_PER_MINUTE);
  return minutes < MINUTES_PER_HOUR
    ? `${minutes}m old`
    : `${Math.floor(minutes / MINUTES_PER_HOUR)}h old`;
};

/**
 * The newest source file the bundle is built from.
 *
 * The staleness question for this artefact is not "how many days" — it is
 * rebuilt per commit — but "is it older than the code it claims to be". One
 * directory listing answers it, and a bundle behind its sources is a container
 * running a harness the host no longer has.
 */
const newestSourceMs = () =>
  readdirSync(SOURCE_DIR)
    .filter((name) => name.endsWith(".ts") && !name.endsWith(".test.ts"))
    .map((name) => statSync(join(SOURCE_DIR, name)).mtimeMs)
    .reduce((newest, at) => Math.max(newest, at), statSync(ENTRY).mtimeMs);

/** One line saying whether the bundle is there, how old it is, and whether it is behind. */
const checkBundle = Effect.fn("BuildEntrypoint.checkBundle")(function* () {
  const fs = yield* FileSystem;
  const outFile = yield* bundlePath;
  const info = yield* Effect.option(fs.stat(outFile));
  if (info._tag === "None") {
    yield* Effect.logInfo(`${outFile}  absent — never bundled on this host`);
    return;
  }
  const builtAtMs = Option.match(info.value.mtime, {
    onNone: () => 0,
    onSome: (at) => at.getTime(),
  });
  const stale = builtAtMs < newestSourceMs();
  yield* Effect.logInfo(
    `${outFile}  ${describeAge(Date.now() - builtAtMs)}, ${Math.round(Number(info.value.size) / BYTES_PER_MB)} MB${
      stale ? " (stale — a source file is newer)" : ""
    }`
  );
});

/** The bundle, written where the orchestrator will mount it from. */
const buildBundle = Effect.fn("BuildEntrypoint.buildBundle")(function* () {
  const fs = yield* FileSystem;
  const outFile = yield* bundlePath;
  yield* Effect.logInfo(`bundling ${ENTRY}`);
  yield* fs
    .makeDirectory(dirname(outFile), { recursive: true })
    .pipe(
      Effect.mapError(
        (cause) => new BundlerUnavailable({ detail: String(cause) })
      )
    );
  const exitCode = yield* Effect.mapError(
    Effect.scoped(runBundler(bundleArgv(outFile))),
    (cause) => new BundlerUnavailable({ detail: String(cause) })
  );
  if (exitCode !== 0) {
    return yield* Effect.fail(new BundleFailed({ exitCode, outFile }));
  }
  return outFile;
});

const buildEntrypoint = Effect.gen(function* () {
  if (isCheckOnly(process.argv.slice(2))) {
    yield* checkBundle();
    return;
  }
  const outFile = yield* buildBundle();
  yield* checkBundle();
  yield* Effect.logInfo(outFile);
});

if (import.meta.main) {
  BunRuntime.runMain(
    buildEntrypoint.pipe(
      Effect.provide(Layer.mergeAll(spawnerLayer, BunFileSystem.layer))
    )
  );
}
