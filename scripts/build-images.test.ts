/**
 * What is worth testing in a build script is the part that runs before the
 * daemon does: which images an invocation asked for, what argv the daemon is
 * handed, and whether a timestamp docker printed can be turned into an age.
 * The build itself takes minutes and is checked by running it.
 */

import { describe, expect, test } from "bun:test";
import {
  ageDays,
  buildArgv,
  isCheckOnly,
  parseDockerTime,
  parseTargets,
  recipeFilesFor,
  utcDate,
} from "./build-images";

describe("parseTargets", () => {
  test("naming nothing means both, so a cron line does not have to say so", () => {
    expect(parseTargets([])).toEqual(["base", "browser"]);
  });

  test("naming one builds one", () => {
    expect(parseTargets(["--browser"])).toEqual(["browser"]);
  });

  test("--check alone still reports on both", () => {
    expect(parseTargets(["--check"])).toEqual(["base", "browser"]);
    expect(isCheckOnly(["--check"])).toBe(true);
    expect(isCheckOnly(["--base"])).toBe(false);
  });
});

describe("recipeFilesFor", () => {
  test("the browser recipe includes the base recipe, because it is built on it", () => {
    const browser = recipeFilesFor("browser");
    expect(browser).toHaveLength(2);
    expect(browser[0]).toBe(recipeFilesFor("base")[0] as string);
  });
});

describe("buildArgv", () => {
  const argv = buildArgv({
    baseImage: null,
    kind: "base",
    tag: "2026-01-02-abc",
  });

  test("builds for arm64 explicitly rather than for whatever the host is", () => {
    expect(argv).toContain("--platform");
    expect(argv[argv.indexOf("--platform") + 1]).toBe("linux/arm64");
  });

  test("tags the immutable tag and latest, both", () => {
    expect(argv).toContain("atm.local/base:2026-01-02-abc");
    expect(argv).toContain("atm.local/base:latest");
  });

  test("the base build passes no base image; the browser build passes the one it was given", () => {
    expect(argv.some((arg) => arg.startsWith("BASE_IMAGE="))).toBe(false);
    const browser = buildArgv({
      baseImage: "atm.local/base:2026-01-02-abc",
      kind: "browser",
      tag: "2026-01-02-def",
    });
    expect(browser).toContain("BASE_IMAGE=atm.local/base:2026-01-02-abc");
  });
});

describe("parseDockerTime", () => {
  test("reads the nanosecond precision docker actually prints", () => {
    expect(parseDockerTime("2026-01-02T03:04:05.123456789Z")).toBe(
      Date.parse("2026-01-02T03:04:05.123Z")
    );
  });

  test("reads a plain RFC 3339 timestamp too", () => {
    expect(parseDockerTime("2026-01-02T03:04:05Z")).toBe(
      Date.parse("2026-01-02T03:04:05Z")
    );
  });

  test("a timestamp that makes no sense is null, not NaN", () => {
    expect(parseDockerTime("not a time")).toBeNull();
  });
});

describe("ageDays", () => {
  test("counts whole days since the image was created", () => {
    const nowMs = Date.parse("2026-01-12T00:00:00Z");
    expect(ageDays({ created: "2026-01-02T00:00:00.000000000Z", nowMs })).toBe(
      10
    );
  });

  test("an unreadable timestamp is an unknown age rather than a wrong one", () => {
    expect(ageDays({ created: "", nowMs: Date.now() })).toBeNull();
  });
});

describe("utcDate", () => {
  test("is UTC, so two hosts building one recipe agree on the day", () => {
    expect(utcDate(new Date("2026-01-02T23:59:59Z"))).toBe("2026-01-02");
  });
});
