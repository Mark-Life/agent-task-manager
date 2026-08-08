import { describe, expect, test } from "bun:test";
import {
  CANONICAL_REPO_URL_EXAMPLE,
  isCloneableRepoUrl,
  parseRepoUrl,
} from "./repo-url";

describe("parseRepoUrl", () => {
  test("takes an https url apart", () => {
    expect(parseRepoUrl("https://github.com/Mark-Life/factory.git")).toEqual({
      cloneUrl: "https://github.com/Mark-Life/factory.git",
      host: "github.com",
      name: "factory",
      owner: "Mark-Life",
      slug: "Mark-Life/factory",
    });
  });

  test("takes the ssh shorthand apart", () => {
    expect(parseRepoUrl("git@github.com:Mark-Life/factory.git")?.slug).toBe(
      "Mark-Life/factory"
    );
    expect(parseRepoUrl("ssh://git@github.com/Mark-Life/factory")?.name).toBe(
      "factory"
    );
  });

  test("normalizes the host and the trailing slash", () => {
    const repo = parseRepoUrl("  https://GitHub.com/o/n/  ");
    expect(repo?.host).toBe("github.com");
    expect(repo?.cloneUrl).toBe("https://GitHub.com/o/n");
  });

  test("accepts a host that is not github", () => {
    expect(parseRepoUrl("https://gitlab.com/o/n.git")?.host).toBe("gitlab.com");
  });

  test("answers null for anything that is not a clone url", () => {
    for (const raw of [
      "",
      "   ",
      "the marketing site repo",
      "owner/name",
      "https://github.com/owner",
      "https://github.com/owner/name/tree/main/pkg",
      "/Users/me/code/project",
    ]) {
      expect(parseRepoUrl(raw)).toBeNull();
    }
  });

  test("the canonical example is one of the forms it accepts", () => {
    expect(parseRepoUrl(CANONICAL_REPO_URL_EXAMPLE)).toEqual({
      cloneUrl: CANONICAL_REPO_URL_EXAMPLE,
      host: "github.com",
      name: "repo",
      owner: "owner",
      slug: "owner/repo",
    });
  });
});

describe("isCloneableRepoUrl", () => {
  test("an unset field is a complete answer, not a mistake", () => {
    expect(isCloneableRepoUrl("")).toBe(true);
    expect(isCloneableRepoUrl("   ")).toBe(true);
  });

  test("it accepts every form the checkout accepts", () => {
    expect(isCloneableRepoUrl("https://github.com/Mark-Life/factory")).toBe(
      true
    );
    expect(isCloneableRepoUrl("git@github.com:Mark-Life/factory.git")).toBe(
      true
    );
    expect(isCloneableRepoUrl("ssh://git@github.com/Mark-Life/factory")).toBe(
      true
    );
    expect(isCloneableRepoUrl("https://gitlab.com/o/n.git")).toBe(true);
  });

  test("it refuses what would clone nothing", () => {
    expect(isCloneableRepoUrl("github.com/owner/repo")).toBe(false);
    expect(isCloneableRepoUrl("the marketing site repo")).toBe(false);
    expect(isCloneableRepoUrl("https://github.com/owner")).toBe(false);
  });
});
