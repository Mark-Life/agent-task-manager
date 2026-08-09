/**
 * The parts of a skill install that are decided before anything is written: the
 * two paths one name resolves to, the lock's format, and what an update would
 * change.
 *
 * All pure, so they are asserted without a disk, a network or a database — the
 * routes over them are exercised against real files in the gateway. What is
 * defended here is what those routes cannot see: the link text is relative, the
 * lock is the same four-field file the repository already carries, and a
 * comparison notices a file that only changed inside.
 */

import { describe, expect, test } from "bun:test";
import { SkillName, SkillSourcePath } from "@workspace/domain";
import { Schema } from "effect";
import {
  AGENT_SKILLS_DIR,
  CLAUDE_SKILLS_DIR,
  compareSkillFiles,
  EMPTY_SKILLS_LOCK,
  parseSkillsLock,
  type SkillFile,
  serializeSkillsLock,
  skillHashOf,
  skillPathsOf,
  withoutSkill,
  withSkill,
} from "./skills";

const name = Schema.decodeUnknownSync(SkillName)("writing");

/** Bytes, spelled the way a fetch produces them. */
const file = (path: string, body: string): SkillFile => ({
  bytes: new TextEncoder().encode(body),
  path,
});

const entry = {
  computedHash: "a".repeat(64),
  skillPath: Schema.decodeUnknownSync(SkillSourcePath)(
    "skills/writing/SKILL.md"
  ),
  source: "acme/skills",
  sourceType: "github",
} as const;

describe("skillPathsOf", () => {
  /**
   * The one property a test on the host would otherwise never catch. An
   * absolute link resolves perfectly well here and names a path no container
   * can see, so the skill would simply be missing inside the sandbox with
   * nothing on the host to show for it.
   */
  test("links Claude's directory at Codex's with a relative path", () => {
    const paths = skillPathsOf(name);

    expect(paths.directory).toBe(`${AGENT_SKILLS_DIR}/writing`);
    expect(paths.link).toBe(`${CLAUDE_SKILLS_DIR}/writing`);
    expect(paths.linkTarget).toBe("../../.agents/skills/writing");
    expect(paths.linkTarget.startsWith("/")).toBe(false);
  });

  /** The link climbs exactly as far as the directory holding it is deep. */
  test("climbs out of the link's own directory and no further", () => {
    const paths = skillPathsOf(name);
    const from = paths.link.split("/").slice(0, -1);
    const climbed = paths.linkTarget
      .split("/")
      .filter((segment) => segment === "..").length;

    expect(climbed).toBe(from.length);
  });
});

describe("the lock", () => {
  test("round-trips through the file it is written as", () => {
    const lock = withSkill({ entry, lock: EMPTY_SKILLS_LOCK, name });

    const text = serializeSkillsLock(lock);

    expect(parseSkillsLock(text)).toEqual(lock);
    expect(text.endsWith("\n")).toBe(true);
  });

  /**
   * Sorted on the way out, so reinstalling a skill that did not change produces
   * the same bytes and the scope's history holds no commit for it.
   */
  test("writes its skills in name order whatever order they arrived in", () => {
    const second = Schema.decodeUnknownSync(SkillName)("auditing");
    const one = withSkill({ entry, lock: EMPTY_SKILLS_LOCK, name });
    const both = withSkill({ entry, lock: one, name: second });

    const text = serializeSkillsLock(both);

    expect(text.indexOf("auditing")).toBeLessThan(text.indexOf("writing"));
  });

  test("forgets a skill without disturbing the others", () => {
    const second = Schema.decodeUnknownSync(SkillName)("auditing");
    const both = withSkill({
      entry,
      lock: withSkill({ entry, lock: EMPTY_SKILLS_LOCK, name }),
      name: second,
    });

    const left = withoutSkill({ lock: both, name });

    expect(Object.keys(left.skills)).toEqual(["auditing"]);
  });

  /**
   * Null rather than an empty lock, because the caller has to tell "nothing
   * installed" from "this file is not a lock" — the second one must not be
   * quietly overwritten with the first.
   */
  test("reads anything that is not a lock as no answer at all", () => {
    expect(parseSkillsLock("not json")).toBeNull();
    expect(parseSkillsLock('{"skills":{"a":{}},"version":1}')).toBeNull();
    expect(parseSkillsLock('{"version":1}')).toBeNull();
  });
});

describe("skillHashOf", () => {
  /** Every file counts, so an update that only touched a reference is still an update. */
  test("changes when any file does, and not when order does", () => {
    const first = [
      file("SKILL.md", "# Writing\n"),
      file("references/style.md", "Short.\n"),
    ];
    const reordered = [first[1] as SkillFile, first[0] as SkillFile];
    const edited = [
      file("SKILL.md", "# Writing\n"),
      file("references/style.md", "Shorter.\n"),
    ];

    expect(skillHashOf(reordered)).toBe(skillHashOf(first));
    expect(skillHashOf(edited)).not.toBe(skillHashOf(first));
  });
});

describe("compareSkillFiles", () => {
  /**
   * What somebody reads before accepting an update. A removal is in the answer
   * because applying one prunes the file, and a person relying on it should see
   * that before agreeing rather than afterwards.
   */
  test("names what is added, changed, removed and left alone", () => {
    const changes = compareSkillFiles({
      incoming: [
        file("SKILL.md", "# Writing\n\nSay it once.\n"),
        file("references/tone.md", "Plain words.\n"),
      ],
      installed: [
        file("SKILL.md", "# Writing\n"),
        file("references/style.md", "Short.\n"),
      ],
    });

    expect(changes).toEqual([
      {
        bytes: 24,
        content: "# Writing\n\nSay it once.\n",
        path: "SKILL.md",
        status: "changed",
      },
      {
        bytes: 13,
        content: "Plain words.\n",
        path: "references/tone.md",
        status: "added",
      },
      {
        bytes: 0,
        content: null,
        path: "references/style.md",
        status: "removed",
      },
    ]);
  });

  test("carries no body for a file that did not move", () => {
    const same = [file("SKILL.md", "# Writing\n")];

    const changes = compareSkillFiles({ incoming: same, installed: same });

    expect(changes).toEqual([
      { bytes: 10, content: null, path: "SKILL.md", status: "unchanged" },
    ]);
  });

  /** Bytes that are not text are reported as changed with nothing to render. */
  test("offers no text for bytes that are not text", () => {
    const changes = compareSkillFiles({
      incoming: [
        { bytes: new Uint8Array([0xff, 0xfe, 0x41]), path: "logo.png" },
      ],
      installed: [],
    });

    expect(changes[0]?.status).toBe("added");
    expect(changes[0]?.content).toBeNull();
  });
});
