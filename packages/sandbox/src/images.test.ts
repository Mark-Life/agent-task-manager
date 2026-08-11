/**
 * The claims worth testing about a name are the ones a rename would quietly
 * break: that a task naming no image gets the base one, that a task naming any
 * image gets exactly that, and that a build tag is unambiguous about what it was
 * built from.
 */

import { describe, expect, test } from "bun:test";
import {
  buildTag,
  DEFAULT_SANDBOX_IMAGE,
  IMAGE_KINDS,
  imageRef,
  imageRepository,
  LATEST_TAG,
  RECIPE_DIGEST_CHARS,
  sandboxImageFor,
} from "./images";

/** A repository that names a registry host, which is what stops a public pull. */
const REGISTRY_QUALIFIED = /^atm\.local\//;

describe("image names", () => {
  test("every repository carries a registry host, so a missing image cannot resolve to a public one", () => {
    for (const kind of IMAGE_KINDS) {
      expect(imageRepository(kind)).toMatch(REGISTRY_QUALIFIED);
    }
  });

  test("a reference is its repository and tag, and nothing is implied", () => {
    expect(imageRef({ kind: "base", tag: "2026-01-02-abcdef123456" })).toBe(
      "atm.local/base:2026-01-02-abcdef123456"
    );
  });
});

describe("sandboxImageFor", () => {
  test("a task that names no image gets the base image's moving tag", () => {
    expect(sandboxImageFor(null)).toBe(DEFAULT_SANDBOX_IMAGE);
    expect(DEFAULT_SANDBOX_IMAGE).toBe(`atm.local/base:${LATEST_TAG}`);
  });

  test("a named image is passed through untouched, including one this file never heard of", () => {
    expect(sandboxImageFor("atm.local/base:2026-01-02-abcdef123456")).toBe(
      "atm.local/base:2026-01-02-abcdef123456"
    );
    expect(sandboxImageFor("ghcr.io/someone/experiment:v3")).toBe(
      "ghcr.io/someone/experiment:v3"
    );
  });
});

describe("buildTag", () => {
  test("carries the date first, so tags sort by age", () => {
    const tag = buildTag({ date: "2026-01-02", recipeDigest: "a".repeat(64) });
    expect(tag.startsWith("2026-01-02-")).toBe(true);
  });

  test("clips the digest to a readable prefix", () => {
    const tag = buildTag({ date: "2026-01-02", recipeDigest: "b".repeat(64) });
    expect(tag).toBe(`2026-01-02-${"b".repeat(RECIPE_DIGEST_CHARS)}`);
  });

  test("two recipes built on one day are two tags", () => {
    const date = "2026-01-02";
    expect(buildTag({ date, recipeDigest: "c".repeat(64) })).not.toBe(
      buildTag({ date, recipeDigest: "d".repeat(64) })
    );
  });
});
