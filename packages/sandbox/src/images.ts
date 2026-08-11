/**
 * What the sandbox image is called. Pure naming — nothing here talks to a
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
 * The images this repository builds. One, and it carries a Chromium.
 *
 * There were two. `browser` was `base` plus Chromium, opted into per task
 * through `task.sandbox_image`, on the argument that several hundred megabytes
 * is start latency every run would otherwise pay. Neither half held up: no run
 * was ever started from it, and nothing about starting a container reads the
 * image's size — `--pull=missing` against a registry that resolves nowhere means
 * the daemon mounts local layers or fails, and it never downloads. Meanwhile
 * runs that needed a page built themselves a browser at run time. See
 * docker/README.md and `docker/base.Dockerfile`'s header.
 *
 * A list of one rather than a bare constant, because the kind is the repository
 * half of every name here and the sweep in `scripts/build-images.ts` walks these
 * repositories by kind. A second image, if one is ever worth building again, is
 * a member here and a Dockerfile — not a reshaped module.
 */
export const IMAGE_KINDS = ["base"] as const;

/** Which image a run wants. */
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
 * The image a task takes when it names none, which is every task that has not
 * pinned a dated tag.
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
 *
 * With one image kind the field is no longer how a run asks for a capability;
 * it is how a task pins a build. That is the whole reason it stays: the escape
 * hatch that lets somebody try an image built by hand, or hold a task on last
 * week's toolchain, without a deploy.
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
