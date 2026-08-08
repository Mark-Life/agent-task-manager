import { describe, expect, test } from "bun:test";
import { parseRepoUrl } from "@workspace/domain";
import { REPO_URL_PLACEHOLDER, repoUrlProblem } from "./repo-url";

describe("repoUrlProblem", () => {
  test("an empty field is not a problem", () => {
    expect(repoUrlProblem("")).toBeNull();
    expect(repoUrlProblem("   ")).toBeNull();
  });

  test("it accepts what the checkout accepts, https and ssh alike", () => {
    for (const raw of [
      "https://github.com/Mark-Life/agent-task-manager",
      "https://github.com/Mark-Life/agent-task-manager.git",
      "git@github.com:Mark-Life/peektrace.git",
      "ssh://git@github.com/Mark-Life/peektrace",
      "https://gitlab.com/owner/repo.git",
    ]) {
      expect(repoUrlProblem(raw)).toBeNull();
    }
  });

  test("it names the shape it wants instead of saying 'invalid'", () => {
    const problem = repoUrlProblem("github.com/Mark-Life/agent-task-manager");
    expect(problem).toContain(REPO_URL_PLACEHOLDER);
  });

  test("it refuses what would clone nothing", () => {
    for (const raw of [
      "github.com/owner/repo",
      "owner/repo",
      "the marketing site repo",
      "https://github.com/Mark-Life",
      "https://github.com/Mark-Life/atm/blob/main/README.md",
    ]) {
      expect(repoUrlProblem(raw)).not.toBeNull();
    }
  });

  test("the placeholder it advertises is a URL the rule accepts", () => {
    expect(repoUrlProblem(REPO_URL_PLACEHOLDER)).toBeNull();
    expect(parseRepoUrl(REPO_URL_PLACEHOLDER)?.host).toBe("github.com");
  });

  test("it is the checkout's rule and not a second one", () => {
    for (const raw of [
      "https://github.com/o/n",
      "git@github.com:o/n.git",
      "not a url",
      "https://github.com/o",
      "",
    ]) {
      const cloneable = raw.trim() === "" || parseRepoUrl(raw) !== null;
      expect(repoUrlProblem(raw) === null).toBe(cloneable);
    }
  });
});
