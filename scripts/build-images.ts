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
 * Every build also sweeps, because nothing else on the host does. A build
 * writes two tags and removes none, so a weekly rebuild leaves last week's
 * images and last week's build cache on the disk for as long as the disk lasts.
 * The sweep removes old dated tags by name, newest {@link KEPT_BUILDS} kept,
 * and drops the build cache. Removing by name is the whole safety of it:
 * `docker image prune -a` would reclaim the same bytes and take `latest` with
 * it, and `atm.local` is a registry that does not exist, so there is no pull to
 * fall back on — the next run would fail until somebody rebuilt.
 *
 * Usage:
 *
 *   bun run images:build              both images, then sweep what they replaced
 *   bun run images:build --base       just the base image
 *   bun run images:build --browser    just the browser image, on the base `latest`
 *   bun run images:build --check      what exists locally, how old it is, and what a
 *                                     sweep would remove; changes nothing
 *   bun run images:build --prune      sweep only; builds nothing
 *   bun run images:build --no-prune   build and leave the old tags alone
 *   bun run images:build --keep=4     how many dated builds per image survive a sweep
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

/**
 * How many dated builds of one image kind a sweep leaves behind, on top of
 * whatever `latest` points at. Two, which at the weekly cadence is the same two
 * weeks {@link STALE_AFTER_DAYS} calls fresh: the build a run would get today,
 * and the one an operator rolls back to when today's is wrong.
 *
 * It is also what a pinned task can count on. `task.sandbox_image` may name a
 * dated tag, and this script cannot see the board — asking a build to read the
 * database would make an image build need a database. So the contract is the
 * number rather than a lookup: a pin older than the last two builds is a pin
 * that will stop resolving, and `--keep` is how an operator holding one buys
 * more time.
 */
const KEPT_BUILDS = 2;

/** How `--keep` is spelled. */
const KEEP_PREFIX = "--keep=";

/** Separates the fields of one listed tag. Neither field can contain it. */
const FIELD_SEPARATOR = "\t";

/** The tag `docker image ls` prints for an image with no tag at all. */
const UNTAGGED = "<none>";

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

/** Whether the invocation wants the sweep and no build. */
export const isPruneOnly = (argv: readonly string[]) =>
  argv.includes("--prune");

/**
 * Whether a build should sweep afterwards. It should, unless told not to —
 * the disk filling up is the default outcome, so leaving old tags in place is
 * the thing an operator has to ask for.
 */
export const shouldPrune = (argv: readonly string[]) =>
  !argv.includes("--no-prune");

/**
 * How many dated builds to keep. Anything that is not a whole number of at
 * least one falls back to the default: a typo in a cron line must not turn a
 * sweep into `--keep=NaN`, which would compare false everywhere and remove
 * every dated tag on the host.
 */
export const parseKeep = (argv: readonly string[]) => {
  const named = argv.find((arg) => arg.startsWith(KEEP_PREFIX));
  if (named === undefined) {
    return KEPT_BUILDS;
  }
  const parsed = Number(named.slice(KEEP_PREFIX.length));
  return Number.isInteger(parsed) && parsed >= 1 ? parsed : KEPT_BUILDS;
};

/** One tag of one repository, as the daemon lists it. */
export interface TaggedImage {
  /** The image's own id, which several tags can share. */
  readonly id: string;
  readonly tag: string;
}

/** What one sweep asks the daemon to list: every tag of one repository, with its image id. */
export const listArgv = (kind: ImageKind): readonly string[] => [
  "image",
  "ls",
  imageRepository(kind),
  `--format={{.Tag}}${FIELD_SEPARATOR}{{.ID}}`,
];

/**
 * The listing, as rows. A line missing either field is dropped rather than
 * guessed at, and an untagged image is skipped — it has no name to remove it
 * by, and a dangling image is `docker image prune`'s business, not a sweep's.
 */
export const parseTagList = (stdout: string): readonly TaggedImage[] => {
  const rows: TaggedImage[] = [];
  for (const line of stdout.split("\n")) {
    const [tag, id] = line.trim().split(FIELD_SEPARATOR);
    if (tag !== undefined && tag !== "" && tag !== UNTAGGED && id) {
      rows.push({ id, tag });
    }
  }
  return rows;
};

/**
 * Which tags of one repository a sweep removes, given everything the daemon
 * holds for it.
 *
 * Pure, and the only part of the sweep worth testing: everything else is a
 * daemon. Three rules, each of which is a way the host could be broken.
 *
 * `latest` is never named, because nothing can pull it back. Neither is any
 * dated tag sharing `latest`'s image id — untagging that one would be harmless
 * today and a run pinned to a tag that no longer exists tomorrow. And the
 * newest {@link KEPT_BUILDS} survive, sorted by tag: the tag opens with the
 * build date, so a string sort is a date sort, and two builds on one day break
 * the tie by recipe digest, which is arbitrary but stable.
 */
export const staleTags = (input: {
  readonly keep: number;
  readonly kind: ImageKind;
  readonly rows: readonly TaggedImage[];
}): readonly string[] => {
  const moving = new Set(
    input.rows.filter((row) => row.tag === LATEST_TAG).map((row) => row.id)
  );
  return input.rows
    .filter((row) => row.tag !== LATEST_TAG)
    .sort((left, right) => right.tag.localeCompare(left.tag))
    .slice(input.keep)
    .filter((row) => !moving.has(row.id))
    .map((row) => imageRef({ kind: input.kind, tag: row.tag }));
};

/**
 * What a sweep asks the daemon to remove. No `--force`: an image a container
 * still holds is a refusal to report, not something to take out from under a
 * running turn.
 */
export const removeArgv = (refs: readonly string[]): readonly string[] => [
  "image",
  "rm",
  ...refs,
];

/**
 * What clears the build cache. `--all` rather than a `until=` filter, because
 * the cache is only worth keeping for a build that reuses it, and a rebuild
 * that hits cache is a rebuild that picked up none of the Debian security
 * updates it exists to pick up. So the cache from a finished build has no next
 * reader, and it is gigabytes.
 */
export const BUILD_CACHE_PRUNE_ARGV: readonly string[] = [
  "builder",
  "prune",
  "--all",
  "--force",
];

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

/**
 * The dated tags of one image kind that a sweep would remove.
 *
 * A listing the daemon refuses is an empty answer rather than a failure. This
 * runs after a build that already succeeded, and failing the script there would
 * report a build that happened as a build that did not.
 */
const staleTagsFor = Effect.fn("BuildImages.staleTagsFor")(function* (input: {
  readonly keep: number;
  readonly kind: ImageKind;
}) {
  const { exitCode, stdout } = yield* Effect.mapError(
    Effect.scoped(dockerRead(listArgv(input.kind))),
    asUnavailable
  );
  if (exitCode !== 0) {
    yield* Effect.logWarning(
      `could not list ${imageRepository(input.kind)} — nothing swept for it`
    );
    return [];
  }
  return staleTags({
    keep: input.keep,
    kind: input.kind,
    rows: parseTagList(stdout),
  });
});

/** Old dated tags of one image kind, removed by name. */
const sweepKind = Effect.fn("BuildImages.sweepKind")(function* (input: {
  readonly keep: number;
  readonly kind: ImageKind;
}) {
  const refs = yield* staleTagsFor(input);
  if (refs.length === 0) {
    yield* Effect.logInfo(
      `${imageRepository(input.kind)}  nothing to remove, ${input.keep} kept`
    );
    return;
  }
  yield* Effect.logInfo(`removing ${refs.join(" ")}`);
  const exitCode = yield* Effect.mapError(
    Effect.scoped(dockerStreamed(removeArgv(refs))),
    asUnavailable
  );
  if (exitCode !== 0) {
    // The usual reason is a container still holding the image, which is a run
    // in flight and the next sweep's problem.
    yield* Effect.logWarning(
      `docker refused to remove one of ${refs.join(" ")} — left in place`
    );
  }
});

/**
 * The whole sweep: old tags of each kind, then the build cache.
 *
 * The cache goes last and unconditionally. It is the larger half of what a
 * rebuild leaves behind, and unlike a tag it belongs to nobody — no run names
 * it, so nothing breaks when it is gone.
 */
const sweep = Effect.fn("BuildImages.sweep")(function* (input: {
  readonly keep: number;
  readonly targets: readonly ImageKind[];
}) {
  for (const kind of input.targets) {
    yield* sweepKind({ keep: input.keep, kind });
  }
  yield* Effect.logInfo("pruning the build cache");
  const exitCode = yield* Effect.mapError(
    Effect.scoped(dockerStreamed(BUILD_CACHE_PRUNE_ARGV)),
    asUnavailable
  );
  if (exitCode !== 0) {
    yield* Effect.logWarning("docker refused to prune the build cache");
  }
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
  readonly keep: number;
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
  const stale = yield* staleTagsFor({ keep: input.keep, kind: input.kind });
  if (stale.length > 0) {
    yield* Effect.logInfo(`  a sweep would remove: ${stale.join(" ")}`);
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
  const keep = parseKeep(argv);
  if (isCheckOnly(argv)) {
    const nowMs = Date.now();
    for (const kind of targets) {
      yield* checkImage({ keep, kind, nowMs });
    }
    return;
  }
  if (isPruneOnly(argv)) {
    yield* sweep({ keep, targets });
    return;
  }
  const built = yield* buildAll(targets);
  for (const image of built) {
    yield* Effect.logInfo(image);
  }
  // After the build, so the tags being counted include the one just written and
  // `latest` already points at it.
  if (shouldPrune(argv)) {
    yield* sweep({ keep, targets });
  }
});

if (import.meta.main) {
  BunRuntime.runMain(buildImages.pipe(Effect.provide(spawnerLayer)));
}
