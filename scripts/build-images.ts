#!/usr/bin/env bun

/**
 * Builds the two sandbox images and says what it produced.
 *
 * A run's image is the one thing about a sandbox that is decided somewhere
 * other than in code: it is built here, by a human or a cron entry, and read
 * back by an orchestrator that only knows a name. So this script is where the
 * name is minted, and it mints it from `@workspace/sandbox`'s own constants
 * rather than from a string in a shell alias — the failure it exists to prevent
 * is an image built as one thing and looked for as another.
 *
 * Two immutable facts land on every build. Each image gets a dated tag carrying
 * a digest of the Dockerfile it was built from, and `latest` is repointed at it.
 * The dated tag is what a task pins when it wants a frozen toolchain; `latest`
 * is what the default resolves to, so a scheduled rebuild reaches runs without
 * anyone editing a row.
 *
 * The browser image is built against the base image from the same invocation,
 * by its immutable tag, never `latest`. Building it against a moving tag makes
 * a browser image whose base half is whatever was on disk at the time, which is
 * a pair of images that can drift while both look current.
 *
 * Usage:
 *
 *   bun run images:build              both images
 *   bun run images:build --base       just the base image
 *   bun run images:build --browser    just the browser image, on the base `latest`
 *   bun run images:build --check      what exists locally and how old it is; builds nothing
 *
 * A build takes minutes and prints the daemon's output as it goes, because a
 * silent five-minute command is one nobody can tell from a hung one.
 */

import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import process from "node:process";
import { BunRuntime } from "@effect/platform-bun";
import * as BunChildProcessSpawner from "@effect/platform-bun/BunChildProcessSpawner";
import * as BunFileSystem from "@effect/platform-bun/BunFileSystem";
import * as BunPath from "@effect/platform-bun/BunPath";
import {
  buildTag,
  IMAGE_KINDS,
  type ImageKind,
  imageRef,
  imageRepository,
  LATEST_TAG,
} from "@workspace/sandbox";
import { Effect, Layer, Schema, Stream } from "effect";
import * as ChildProcess from "effect/unstable/process/ChildProcess";
import { ChildProcessSpawner } from "effect/unstable/process/ChildProcessSpawner";

/** The daemon client. Resolved on PATH — a docker install that is not there is a failure to report, not to work around. */
const DOCKER = "docker";

/**
 * The only architecture these images are built for. Stated rather than left to
 * the host: the Dockerfiles fetch aarch64 archives by name, and a build that
 * silently produced an amd64 image under an emulator would take twenty minutes
 * and then fail on the deployment host.
 */
const PLATFORM = "linux/arm64";

/** The build context. Neither Dockerfile copies anything, so this is only a directory to point at. */
const CONTEXT_DIR = new URL("../docker/", import.meta.url).pathname;

/** The recipe for one image kind, relative to the repository root. */
const DOCKERFILE = {
  base: new URL("../docker/base.Dockerfile", import.meta.url).pathname,
  browser: new URL("../docker/browser.Dockerfile", import.meta.url).pathname,
} as const satisfies Record<ImageKind, string>;

/**
 * How the browser image is told which base to build on. Matches the `ARG` at
 * the top of `browser.Dockerfile`; the two spellings are the reason this is a
 * constant.
 */
const BASE_IMAGE_ARG = "BASE_IMAGE";

/**
 * How old an image may get before `--check` calls it stale, in days. Twice the
 * weekly rebuild cadence, so one missed run is not an alarm and two are.
 */
const STALE_AFTER_DAYS = 14;

const MS_PER_DAY = 86_400_000;

const BYTES_PER_MB = 1_000_000;

/**
 * How much of an image's content digest to print: `sha256:` plus twelve hex
 * characters, the short form docker itself shows.
 */
const SHORT_DIGEST_CHARS = 19;

/** The label prefix `base.Dockerfile` records its pinned versions under. */
const VERSION_LABEL_PREFIX = "com.atm.version.";

/** Docker is not there, or will not answer. */
class DockerUnavailable extends Schema.TaggedErrorClass<DockerUnavailable>()(
  "BuildImages.DockerUnavailable",
  { detail: Schema.String }
) {}

/** A build ran and the daemon rejected it. The output is already on the log above. */
class BuildFailed extends Schema.TaggedErrorClass<BuildFailed>()(
  "BuildImages.BuildFailed",
  { exitCode: Schema.Number, image: Schema.String }
) {}

/** `docker image inspect` answered with something this script cannot read. */
class InspectUnreadable extends Schema.TaggedErrorClass<InspectUnreadable>()(
  "BuildImages.InspectUnreadable",
  { detail: Schema.String, image: Schema.String }
) {}

/**
 * The part of `docker image inspect` this script reads. Deliberately partial:
 * the daemon's record has fifty fields and adding one must not break a build.
 */
const ImageInspect = Schema.Struct({
  Config: Schema.Struct({
    Labels: Schema.NullOr(Schema.Record(Schema.String, Schema.String)),
  }),
  Created: Schema.String,
  Id: Schema.String,
  RepoTags: Schema.Array(Schema.String),
  Size: Schema.Number,
});

const decodeInspect = Schema.decodeUnknownEffect(Schema.Array(ImageInspect));

/**
 * Which images the invocation asked for. Naming neither means both, because the
 * scheduled rebuild wants both and a cron line should not have to say so.
 */
export const parseTargets = (argv: readonly string[]): readonly ImageKind[] => {
  const named = IMAGE_KINDS.filter((kind) => argv.includes(`--${kind}`));
  return named.length === 0 ? IMAGE_KINDS : named;
};

/** Whether the invocation only wants a report. */
export const isCheckOnly = (argv: readonly string[]) =>
  argv.includes("--check");

/**
 * A digest of what an image is built from. The browser recipe includes the base
 * recipe because it is built on it: a change to the base image is a change to
 * the browser image, and a tag that said otherwise would be the one lie an
 * immutable tag must not tell.
 */
export const recipeFilesFor = (kind: ImageKind): readonly string[] =>
  kind === "browser"
    ? [DOCKERFILE.base, DOCKERFILE.browser]
    : [DOCKERFILE.base];

/** `YYYY-MM-DD` in UTC, so two hosts building the same recipe agree on the day. */
export const utcDate = (at: Date) => at.toISOString().slice(0, 10);

/** The sub-second part of an RFC 3339 timestamp, with its first three digits kept. */
const SUB_SECOND = /\.(\d{3})\d*/;

/**
 * Docker reports creation time in RFC 3339 with nanosecond precision, which
 * `Date` parses inconsistently across engines. Cutting the fraction to
 * milliseconds is lossless for the one question asked of it — how many days ago
 * — and turns a parse that sometimes returns `NaN` into one that never does.
 */
export const parseDockerTime = (created: string) => {
  const trimmed = created.replace(SUB_SECOND, ".$1");
  const parsed = Date.parse(trimmed);
  return Number.isNaN(parsed) ? null : parsed;
};

/** Whole days between an image's creation and now, or null when the timestamp made no sense. */
export const ageDays = (input: {
  readonly created: string;
  readonly nowMs: number;
}) => {
  const createdMs = parseDockerTime(input.created);
  return createdMs === null
    ? null
    : Math.floor((input.nowMs - createdMs) / MS_PER_DAY);
};

/** What one build asks the daemon to do. Pure, so the argv is assertable without a daemon. */
export const buildArgv = (input: {
  readonly baseImage: string | null;
  readonly kind: ImageKind;
  readonly tag: string;
}): readonly string[] => [
  "build",
  "--platform",
  PLATFORM,
  // Plain progress because this output is read from a log file as often as
  // from a terminal, and the default renderer redraws lines a log cannot show.
  "--progress=plain",
  "--file",
  DOCKERFILE[input.kind],
  "--tag",
  imageRef({ kind: input.kind, tag: input.tag }),
  "--tag",
  imageRef({ kind: input.kind, tag: LATEST_TAG }),
  ...(input.baseImage === null
    ? []
    : ["--build-arg", `${BASE_IMAGE_ARG}=${input.baseImage}`]),
  CONTEXT_DIR,
];

/**
 * Bun's process spawner and the two services it needs. Named rather than taken
 * from the aggregate platform layer, which would also claim this process's
 * stdin for a terminal it has no use for.
 */
const spawnerLayer = BunChildProcessSpawner.layer.pipe(
  Layer.provide(Layer.mergeAll(BunFileSystem.layer, BunPath.layer))
);

/** Docker as a command, with the current environment inherited. */
const dockerCommand = (args: readonly string[]) =>
  ChildProcess.make(DOCKER, args, { extendEnv: true });

/** A docker invocation whose output belongs on the log as it arrives. */
const dockerStreamed = Effect.fn("BuildImages.dockerStreamed")(function* (
  args: readonly string[]
) {
  const spawner = yield* ChildProcessSpawner;
  const handle = yield* spawner.spawn(dockerCommand(args));
  yield* Stream.runForEach(
    Stream.splitLines(Stream.decodeText(handle.all)),
    (line) => (line.length === 0 ? Effect.void : Effect.logInfo(line))
  );
  return yield* handle.exitCode;
});

/** A docker invocation whose stdout is the answer. Stderr is discarded — the exit code carries the verdict. */
const dockerRead = Effect.fn("BuildImages.dockerRead")(function* (
  args: readonly string[]
) {
  const spawner = yield* ChildProcessSpawner;
  const handle = yield* spawner.spawn(dockerCommand(args));
  const stdout = yield* Stream.mkString(Stream.decodeText(handle.stdout));
  yield* Stream.runDrain(handle.stderr);
  const exitCode = yield* handle.exitCode;
  return { exitCode, stdout };
});

/** Anything the platform threw while talking to docker is docker being unreachable. */
const asUnavailable = (detail: unknown) =>
  new DockerUnavailable({ detail: String(detail) });

/** The digest of the recipe an image kind is built from. */
const recipeDigestOf = (kind: ImageKind) =>
  Effect.sync(() => {
    const hash = createHash("sha256");
    for (const file of recipeFilesFor(kind)) {
      hash.update(readFileSync(file));
    }
    return hash.digest("hex");
  });

/** What one image looks like on this host right now, or null when it is not here. */
const inspect = Effect.fn("BuildImages.inspect")(function* (image: string) {
  const { exitCode, stdout } = yield* Effect.mapError(
    Effect.scoped(dockerRead(["image", "inspect", image])),
    asUnavailable
  );
  // A missing image is the ordinary answer to "is this built yet", so it is a
  // null rather than a failure; anything else the daemon refuses shows up as an
  // unreadable inspection, which names the image.
  if (exitCode !== 0) {
    return null;
  }
  const unreadable = (cause: unknown) =>
    new InspectUnreadable({ detail: String(cause), image });
  const parsed = yield* Effect.try({
    catch: unreadable,
    try: () => JSON.parse(stdout) as unknown,
  });
  const decoded = yield* Effect.mapError(decodeInspect(parsed), unreadable);
  return decoded[0] ?? null;
});

/** One image built, tagged twice, and reported by its immutable tag. */
const buildImage = Effect.fn("BuildImages.buildImage")(function* (input: {
  readonly baseImage: string | null;
  readonly kind: ImageKind;
  readonly now: Date;
}) {
  const tag = buildTag({
    date: utcDate(input.now),
    recipeDigest: yield* recipeDigestOf(input.kind),
  });
  const image = imageRef({ kind: input.kind, tag });
  yield* Effect.logInfo(`building ${image}`);
  const exitCode = yield* Effect.mapError(
    Effect.scoped(
      dockerStreamed(
        buildArgv({ baseImage: input.baseImage, kind: input.kind, tag })
      )
    ),
    asUnavailable
  );
  if (exitCode !== 0) {
    return yield* Effect.fail(new BuildFailed({ exitCode, image }));
  }
  yield* Effect.logInfo(
    `built ${image}, also tagged ${imageRef({ kind: input.kind, tag: LATEST_TAG })}`
  );
  return image;
});

/** The pinned versions an image recorded about itself, as `name=value` pairs. */
const versionsOf = (labels: Readonly<Record<string, string>> | null) =>
  Object.entries(labels ?? {})
    .filter(([name]) => name.startsWith(VERSION_LABEL_PREFIX))
    .map(
      ([name, value]) => `${name.slice(VERSION_LABEL_PREFIX.length)} ${value}`
    )
    .sort();

/** One line per image saying whether it is here, how old it is, and what is in it. */
const checkImage = Effect.fn("BuildImages.checkImage")(function* (input: {
  readonly kind: ImageKind;
  readonly nowMs: number;
}) {
  const repository = imageRepository(input.kind);
  const found = yield* inspect(imageRef({ kind: input.kind, tag: LATEST_TAG }));
  if (found === null) {
    yield* Effect.logInfo(`${repository}  absent — never built on this host`);
    return;
  }
  const days = ageDays({ created: found.Created, nowMs: input.nowMs });
  const age =
    days === null
      ? "age unknown"
      : `${days}d old${days > STALE_AFTER_DAYS ? " (stale)" : ""}`;
  const size = Math.round(found.Size / BYTES_PER_MB);
  yield* Effect.logInfo(
    `${repository}  ${age}, ${size} MB, ${found.Id.slice(0, SHORT_DIGEST_CHARS)}`
  );
  yield* Effect.logInfo(`  tags: ${found.RepoTags.join(" ")}`);
  for (const version of versionsOf(found.Config.Labels)) {
    yield* Effect.logInfo(`  ${version}`);
  }
});

/**
 * Builds what was asked for, base first.
 *
 * The base image's immutable tag is threaded into the browser build, so a
 * `--browser`-only invocation is the one case that falls back to `latest` —
 * which is correct, because there is no base build in this invocation to be
 * consistent with.
 */
const buildAll = Effect.fn("BuildImages.buildAll")(function* (
  targets: readonly ImageKind[]
) {
  const now = new Date();
  const built: string[] = [];
  const base = targets.includes("base")
    ? yield* buildImage({ baseImage: null, kind: "base", now })
    : null;
  if (base !== null) {
    built.push(base);
  }
  if (targets.includes("browser")) {
    built.push(
      yield* buildImage({
        baseImage: base ?? imageRef({ kind: "base", tag: LATEST_TAG }),
        kind: "browser",
        now,
      })
    );
  }
  return built;
});

const buildImages = Effect.gen(function* () {
  const argv = process.argv.slice(2);
  const targets = parseTargets(argv);
  if (isCheckOnly(argv)) {
    const nowMs = Date.now();
    for (const kind of targets) {
      yield* checkImage({ kind, nowMs });
    }
    return;
  }
  const built = yield* buildAll(targets);
  for (const image of built) {
    yield* Effect.logInfo(image);
  }
});

if (import.meta.main) {
  BunRuntime.runMain(buildImages.pipe(Effect.provide(spawnerLayer)));
}
