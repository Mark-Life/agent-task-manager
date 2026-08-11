/**
 * What is worth testing in a build script is the part that runs before the
 * daemon does: which images an invocation asked for, what argv the daemon is
 * handed, and whether a timestamp docker printed can be turned into an age.
 * The build itself takes minutes and is checked by running it.
 *
 * The sweep is here for a stronger reason. Every other function in this file
 * decides what to create; that one decides what to delete, on a host where the
 * images it could delete by mistake cannot be pulled back.
 */

import { describe, expect, test } from "bun:test";
import {
  ageDays,
  buildArgv,
  isCheckOnly,
  isPruneOnly,
  listArgv,
  parseDockerTime,
  parseKeep,
  parseTagList,
  parseTargets,
  recipeFilesFor,
  removeArgv,
  shouldPrune,
  staleTags,
  utcDate,
} from "./build-images";

describe("parseTargets", () => {
  test("naming nothing means every kind, so a cron line does not have to say so", () => {
    expect(parseTargets([])).toEqual(["base"]);
  });

  test("naming one builds one", () => {
    expect(parseTargets(["--base"])).toEqual(["base"]);
  });

  test("a flag that is not an image kind selects nothing and so builds everything", () => {
    expect(parseTargets(["--check"])).toEqual(["base"]);
    expect(isCheckOnly(["--check"])).toBe(true);
    expect(isCheckOnly(["--base"])).toBe(false);
  });
});

/** The recipe file name, as the digest reads it off disk. */
const BASE_RECIPE = /base\.Dockerfile$/;

describe("recipeFilesFor", () => {
  test("a kind's recipe is the Dockerfile it is built from", () => {
    const base = recipeFilesFor("base");
    expect(base).toHaveLength(1);
    expect(base[0]).toMatch(BASE_RECIPE);
  });
});

describe("buildArgv", () => {
  const argv = buildArgv({
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

  test("passes no build args, so the recipe digest is the whole recipe", () => {
    expect(argv).not.toContain("--build-arg");
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

describe("prune flags", () => {
  test("a build sweeps unless it is told not to", () => {
    expect(shouldPrune([])).toBe(true);
    expect(shouldPrune(["--no-prune"])).toBe(false);
    expect(isPruneOnly(["--no-prune"])).toBe(false);
    expect(isPruneOnly(["--prune"])).toBe(true);
  });

  test("--prune with no image named sweeps every repository", () => {
    expect(parseTargets(["--prune"])).toEqual(["base"]);
  });
});

describe("parseKeep", () => {
  test("defaults to two dated builds, and takes a number when given one", () => {
    expect(parseKeep([])).toBe(2);
    expect(parseKeep(["--keep=5"])).toBe(5);
    expect(parseKeep(["--prune", "--keep=1"])).toBe(1);
  });

  test("a value that is not a whole number of at least one is the default, not NaN", () => {
    expect(parseKeep(["--keep=oops"])).toBe(2);
    expect(parseKeep(["--keep="])).toBe(2);
    expect(parseKeep(["--keep=0"])).toBe(2);
    expect(parseKeep(["--keep=-3"])).toBe(2);
    expect(parseKeep(["--keep=1.5"])).toBe(2);
  });
});

describe("listArgv", () => {
  test("asks one repository for every tag it holds, with the image id", () => {
    expect(listArgv("base")).toEqual([
      "image",
      "ls",
      "atm.local/base",
      "--format={{.Tag}}\t{{.ID}}",
    ]);
  });
});

describe("parseTagList", () => {
  test("reads a tag and an id per line", () => {
    expect(
      parseTagList("latest\ta1b2c3d4e5f6\n2026-01-02-abc\ta1b2c3d4e5f6\n")
    ).toEqual([
      { id: "a1b2c3d4e5f6", tag: "latest" },
      { id: "a1b2c3d4e5f6", tag: "2026-01-02-abc" },
    ]);
  });

  test("drops an untagged image, which has no name to remove it by", () => {
    expect(parseTagList("<none>\tb2c3d4e5f6a1\n\ngarbage\n")).toEqual([]);
  });
});

describe("staleTags", () => {
  const rows = [
    { id: "c3d4e5f6a1b2", tag: "latest" },
    { id: "c3d4e5f6a1b2", tag: "2026-01-06-ccc" },
    { id: "b2c3d4e5f6a1", tag: "2026-01-04-bbb" },
    { id: "a1b2c3d4e5f6", tag: "2026-01-02-aaa" },
  ];

  test("keeps the newest builds by date and names the rest, fully qualified", () => {
    expect(staleTags({ keep: 2, kind: "base", rows })).toEqual([
      "atm.local/base:2026-01-02-aaa",
    ]);
    expect(staleTags({ keep: 1, kind: "base", rows })).toEqual([
      "atm.local/base:2026-01-04-bbb",
      "atm.local/base:2026-01-02-aaa",
    ]);
  });

  test("never names latest, which nothing could pull back", () => {
    const named = staleTags({ keep: 0, kind: "base", rows });
    expect(named).not.toContain("atm.local/base:latest");
  });

  test("never names a dated tag latest points at, so a pin outlives the sweep", () => {
    expect(staleTags({ keep: 0, kind: "base", rows })).toEqual([
      "atm.local/base:2026-01-04-bbb",
      "atm.local/base:2026-01-02-aaa",
    ]);
  });

  test("keeping more than exist removes nothing", () => {
    expect(staleTags({ keep: 10, kind: "base", rows })).toEqual([]);
  });
});

describe("removeArgv", () => {
  test("removes by name and never forces — an image a container holds stays", () => {
    const argv = removeArgv(["atm.local/base:2026-01-02-aaa"]);
    expect(argv).toEqual(["image", "rm", "atm.local/base:2026-01-02-aaa"]);
    expect(argv).not.toContain("--force");
    expect(argv).not.toContain("-f");
  });
});
