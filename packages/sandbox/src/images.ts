/**
 * What the two sandbox images are called. Pure naming — nothing here talks to a
 * daemon or reads a disk.
 *
 * There are exactly two parties that spell an image name and they never meet:
 * the build script tags what it built, and the orchestrator asks the daemon to
 * run something. A name written twice is a run that fails with
 * `Sandbox.ImageMissing` against an image that was built ten seconds earlier
 * under a name off by a hyphen, so both sides read the name from here.
 *
 * The registry host is fake, and deliberately so. `atm/base` and `atm-base`
 * both resolve to real Docker Hub coordinates, so a container started before
 * the image was built would go and pull a stranger's image and run it under the
 * operator's GitHub token. A hostname with a dot in it makes docker treat the
 * first segment as a registry, and {@link IMAGE_REGISTRY} resolves nowhere — so
 * the same mistake is a DNS failure that names the image, which is what
 * `Sandbox.ImageMissing` was written for.
 */

import { Schema } from "effect";

/**
 * The two images. `base` is what nearly everything runs on; `browser` adds
 * Chromium and is several hundred megabytes heavier, which on a four-core host
 * is start latency every run pays.
 */
export const IMAGE_KINDS = ["base", "browser"] as const;

/** Which of the two images a run wants. */
export const ImageKind = Schema.Literals(IMAGE_KINDS);
export type ImageKind = typeof ImageKind.Type;

/**
 * The registry these images claim to come from. Never contacted: the images are
 * built on the host that runs them. See the module note for why it is not a
 * bare name.
 */
export const IMAGE_REGISTRY = "atm.local";

/** The moving tag, repointed at the end of every build. */
export const LATEST_TAG = "latest";

/**
 * The image a task takes when it names none. Base, because a run that needed a
 * browser would have said so, and paying browser start-up for every coding task
 * is the wrong default on a host that fits three containers.
 */
export const DEFAULT_IMAGE_KIND: ImageKind = "base";

/** The repository one image kind is tagged under, registry included. */
export const imageRepository = (kind: ImageKind) =>
  `${IMAGE_REGISTRY}/${kind}` as const;

/** A fully qualified image reference: repository plus tag. */
export const imageRef = (input: {
  readonly kind: ImageKind;
  readonly tag: string;
}) => `${imageRepository(input.kind)}:${input.tag}`;

/**
 * What a run gets when `task.sandbox_image` is null — the base image at
 * {@link LATEST_TAG}, which is whatever the last scheduled rebuild produced.
 *
 * A moving tag rather than a pinned one is the right default here: the point of
 * rebuilding on a schedule is that runs pick the rebuild up, and a run that
 * needs a frozen toolchain says so by naming the dated tag on its task. Which
 * image actually ran is recorded on `run.sandbox_image` either way, so the
 * moving tag costs no traceability after the fact.
 */
export const DEFAULT_SANDBOX_IMAGE = imageRef({
  kind: DEFAULT_IMAGE_KIND,
  tag: LATEST_TAG,
});

/**
 * The image a task will run on. `task.sandbox_image` only ever selects: a null
 * takes the default, and any other value is passed through untouched — an
 * operator pinning a dated tag, or naming an image this file has never heard
 * of, is making a decision rather than a typo, and rejecting it here would mean
 * a redeploy to try a new image.
 */
export const sandboxImageFor = (selected: string | null) =>
  selected ?? DEFAULT_SANDBOX_IMAGE;

/**
 * How many characters of the recipe digest a build tag carries. Twelve hex
 * characters is what git and docker both settled on for a short digest: long
 * enough that two recipes colliding is not a thing that happens, short enough
 * to read off a log line.
 */
export const RECIPE_DIGEST_CHARS = 12;

/**
 * The immutable tag for one build: the date it was built, then a digest of the
 * recipe that built it.
 *
 * Both halves earn their place. The date is what an operator actually asks —
 * "how old is this image" — and it sorts. The digest is what makes the tag
 * honest: two builds on the same day from different Dockerfiles get different
 * tags, and two builds from an unchanged Dockerfile are visibly the same
 * recipe even though the Debian packages underneath them may have moved. It is
 * a recipe digest, not a content digest; the content digest is the one docker
 * assigns, and that is what `run.sandbox_image` should eventually record.
 */
export const buildTag = (input: {
  /** `YYYY-MM-DD`, the day the build started. */
  readonly date: string;
  /** Hex digest of the Dockerfile bytes the build was driven from. */
  readonly recipeDigest: string;
}) => `${input.date}-${input.recipeDigest.slice(0, RECIPE_DIGEST_CHARS)}`;
