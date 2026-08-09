/**
 * The rule that decides whether a path a caller supplied may be joined to a
 * directory of ours.
 *
 * Everything asserted here is an escape someone would otherwise get: out of the
 * checkout an environment file goes into, out of the scope a proposal is
 * accepted into, and into the `.git` directory of either, where a file is code
 * that runs or a history that lies. The table is the interesting part of the
 * module, so it is a table.
 */

import { describe, expect, it } from "bun:test";
import {
  RELATIVE_PATH_MAX,
  type RelativePathRefusal,
  relativePathRefusalOf,
} from "./relative-path";

describe("a relative path", () => {
  const accepted = [
    ".env",
    ".env.local",
    "apps/web/.env",
    "packages/db/.env.test",
    "a/b/c/d/.env.production",
    ".environment-that-is-not-git",
    "CLAUDE.md",
    "manager/CLAUDE.md",
  ];

  for (const path of accepted) {
    it(`accepts ${path}`, () => {
      expect(relativePathRefusalOf(path)).toBeNull();
    });
  }

  const refused: readonly (readonly [string, RelativePathRefusal])[] = [
    ["", "empty"],
    ["/etc/passwd", "absolute"],
    ["/.env", "absolute"],
    ["../.env", "dot_segment"],
    ["apps/../../.env", "dot_segment"],
    ["apps/./.env", "dot_segment"],
    ["apps//.env", "empty_segment"],
    ["apps/web/", "empty_segment"],
    ["apps\\web\\.env", "backslash"],
    ["..\\.env", "backslash"],
    [".env\u0000.txt", "control_character"],
    [".env\n", "control_character"],
    [".git/hooks/pre-commit", "git_directory"],
    [".git/config", "git_directory"],
    [`${"a/".repeat(RELATIVE_PATH_MAX)}.env`, "too_long"],
  ];

  for (const [path, reason] of refused) {
    it(`refuses ${JSON.stringify(path)} as ${reason}`, () => {
      expect(relativePathRefusalOf(path)).toBe(reason);
    });
  }

  // `.gitignore` and `.github/` share the prefix and are ordinary files: the
  // rule is a segment match, not a `startsWith`.
  it("refuses only the git directory itself", () => {
    expect(relativePathRefusalOf(".gitignore")).toBeNull();
    expect(relativePathRefusalOf(".github/workflows/.env")).toBeNull();
  });

  // A submodule keeps its own hooks, one directory down.
  it("refuses a git directory at any depth", () => {
    expect(relativePathRefusalOf("packages/vendor/.git/hooks/pre-commit")).toBe(
      "git_directory"
    );
  });
});
