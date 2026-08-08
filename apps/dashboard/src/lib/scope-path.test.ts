/**
 * What must hold for a file browser not to lie about a directory.
 *
 * The listing and the routes disagree on purpose — one describes any name a
 * disk can hold, the other accepts only a name it can contain — so the rows
 * that fall in the gap are the whole point of these functions. A path that gets
 * through here and is refused by the server is a click that produces an error
 * message; a path rejected here that the server would have taken is a file
 * nobody can open.
 */

import { describe, expect, test } from "bun:test";
import {
  ancestorsOf,
  joinScopePath,
  nameOf,
  parentOf,
  resolveLinkTarget,
  scopePathOf,
  scopePathProblem,
} from "@/lib/scope-path";

/** A name a filesystem accepts and no request here can carry. */
const CONTROL_CHARACTER_NAME = `notes${String.fromCharCode(7)}.md`;

/**
 * The branded answers, widened back to text.
 *
 * The brand is the point of the functions and says nothing about the value, so
 * an expectation written against it would be the path spelled twice with a cast
 * in between. Widening is an ordinary assignment rather than an assertion, so
 * nothing here can claim a value the function did not produce.
 */
const text = (value: string | null) => value;

describe("scopePathOf", () => {
  test("an ordinary path is one a route will take", () => {
    expect(text(scopePathOf("worker/AGENTS.md"))).toBe("worker/AGENTS.md");
  });

  test("a path climbing out of the scope is not addressable", () => {
    expect(scopePathOf("../../etc/passwd")).toBeNull();
  });

  test("a path into the scope's own history is not addressable", () => {
    expect(scopePathOf(".git/config")).toBeNull();
  });

  test("the scope's own root has no path, so the empty string is refused", () => {
    expect(scopePathOf("")).toBeNull();
  });

  test("a name a disk allows and a request cannot carry stays shut", () => {
    expect(scopePathOf(CONTROL_CHARACTER_NAME)).toBeNull();
    expect(scopePathOf("windows\\style.md")).toBeNull();
  });
});

describe("parentOf", () => {
  test("a file at the root has no parent to go back to", () => {
    expect(parentOf("CLAUDE.md")).toBeNull();
  });

  test("a nested file names the directory holding it", () => {
    expect(text(parentOf(".agents/skills/review/SKILL.md"))).toBe(
      ".agents/skills/review"
    );
  });
});

describe("ancestorsOf", () => {
  test("a deep link says every folder a tree has to open, shallowest first", () => {
    expect(ancestorsOf(".agents/skills/review/SKILL.md")).toEqual([
      ".agents",
      ".agents/skills",
      ".agents/skills/review",
    ]);
  });

  test("a file at the root asks for nothing to be opened", () => {
    expect(ancestorsOf("AGENTS.md")).toEqual([]);
  });
});

describe("nameOf and joinScopePath", () => {
  test("a name put in a directory comes back out of it", () => {
    const path = joinScopePath(".agents/skills", "SKILL.md");

    expect(path).toBe(".agents/skills/SKILL.md");
    expect(nameOf(path)).toBe("SKILL.md");
  });

  test("a name with no directory sits at the scope's root", () => {
    expect(joinScopePath(null, "AGENTS.md")).toBe("AGENTS.md");
  });
});

describe("resolveLinkTarget", () => {
  /**
   * The layout every skill is installed as: the real files under
   * `.agents/skills`, and a relative link beside them for the other CLI. A
   * reader who clicks the link has to reach the file they would be editing.
   */
  test("a skill's link resolves back onto the one real copy", () => {
    expect(
      text(resolveLinkTarget(".claude/skills", "../../.agents/skills/review"))
    ).toBe(".agents/skills/review");
  });

  test("a link beside its target needs no climbing", () => {
    expect(text(resolveLinkTarget("notes", "research.md"))).toBe(
      "notes/research.md"
    );
  });

  test("a link out of the scope leads nowhere this app will follow", () => {
    expect(
      resolveLinkTarget(".claude/skills", "../../../../etc/passwd")
    ).toBeNull();
    expect(resolveLinkTarget(null, "/etc/passwd")).toBeNull();
  });
});

describe("scopePathProblem", () => {
  test("an empty box is not yet a mistake", () => {
    expect(scopePathProblem("")).toBeNull();
  });

  test("a usable path draws no complaint", () => {
    expect(scopePathProblem("notes/research.md")).toBeNull();
  });

  test("each refusal is a sentence about what to type instead", () => {
    expect(scopePathProblem("/etc/hosts")).toContain("inside the scope");
    expect(scopePathProblem("../out")).toContain("stay inside the scope");
    expect(scopePathProblem(".git/config")).toContain("history");
    expect(scopePathProblem("a//b")).toContain("Two slashes");
  });
});
