import { describe, expect, it } from "bun:test";
import { Schema } from "effect";
import {
  ENV_FILE_PATH_MAX,
  EnvFilePath,
  type EnvPathRefusal,
  envPathRefusalOf,
} from "./project-env";

const decode = Schema.decodeUnknownExit(EnvFilePath);

describe("a repo-relative env file path", () => {
  const accepted = [
    ".env",
    ".env.local",
    "apps/web/.env",
    "packages/db/.env.test",
    "a/b/c/d/.env.production",
    ".environment-that-is-not-git",
  ];

  for (const path of accepted) {
    it(`accepts ${path}`, () => {
      expect(envPathRefusalOf(path)).toBeNull();
    });
  }

  const refused: readonly (readonly [string, EnvPathRefusal])[] = [
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
    [`${"a/".repeat(ENV_FILE_PATH_MAX)}.env`, "too_long"],
  ];

  for (const [path, reason] of refused) {
    it(`refuses ${JSON.stringify(path)} as ${reason}`, () => {
      expect(envPathRefusalOf(path)).toBe(reason);
    });
  }

  it("refuses at the schema too, so a bad path never reaches a handler", () => {
    expect(decode("../../.ssh/authorized_keys")._tag).toBe("Failure");
  });

  it("accepts at the schema, which is where the brand comes from", () => {
    expect(decode("apps/web/.env")._tag).toBe("Success");
  });

  // `.gitignore` and `.github/` share the prefix and are ordinary files: the
  // rule is a segment match, not a `startsWith`.
  it("refuses only the git directory itself", () => {
    expect(envPathRefusalOf(".gitignore")).toBeNull();
    expect(envPathRefusalOf(".github/workflows/.env")).toBeNull();
  });

  // A submodule keeps its own hooks, one directory down.
  it("refuses a git directory at any depth", () => {
    expect(envPathRefusalOf("packages/vendor/.git/hooks/pre-commit")).toBe(
      "git_directory"
    );
  });
});
