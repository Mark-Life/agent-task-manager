/**
 * What this panel must not get wrong.
 *
 * Installing a skill here changes what agents are told to do, and which
 * directory it lands in decides how many of them — so the audience has to be on
 * the screen where the choice is made, said as the people rather than as a
 * folder. The other half is honesty about the disk: the lock and the tree can
 * disagree, and a list that hid a missing folder would be a list of what
 * somebody once installed, with no sign of why a run is not getting it.
 *
 * Rendered to static markup rather than through a browser: what is checked is
 * which sentences and controls exist for a given state, and that is settled by
 * the tree.
 */

import { describe, expect, test } from "bun:test";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { InstalledSkill } from "@workspace/api";
import { ProjectId } from "@workspace/domain";
import { renderToStaticMarkup } from "react-dom/server";
import { keys } from "@/api/keys";
import { SkillsPanel, skillProblemOf } from "@/features/skills/skills-panel";

const PROJECT_ID = ProjectId.make("6f1a0b4e-0000-4000-8000-0000000000bb");

/** One installed skill, with only the fields a case is about spelled out. */
const skillOf = (over: Partial<InstalledSkill>) =>
  ({
    computedHash: "9f2b1c7d4e5a6b8c9d0e1f2a3b4c5d6e",
    directory: ".agents/skills/writing",
    link: ".claude/skills/writing",
    linked: true,
    name: "writing",
    present: true,
    skillPath: "skills/writing/SKILL.md",
    source: "acme/house-skills",
    sourceType: "github",
    ...over,
  }) as unknown as InstalledSkill;

const markupFor = (
  skills: readonly InstalledSkill[],
  scope: Parameters<typeof SkillsPanel>[0]["scope"] = { scope: "workspace" }
) => {
  const queryClient = new QueryClient();
  queryClient.setQueryData(
    keys.scopeSkills(
      scope.scope === "project" ? `project:${PROJECT_ID}` : scope.scope
    ),
    skills
  );
  return renderToStaticMarkup(
    <QueryClientProvider client={queryClient}>
      <SkillsPanel scope={scope} />
    </QueryClientProvider>
  );
};

describe("SkillsPanel", () => {
  test("the workspace directory says it reaches every agent in it", () => {
    const markup = markupFor([]);

    expect(markup).toContain("every agent in this workspace");
  });

  test("a project's directory says it reaches that project's workers and no others", () => {
    const markup = markupFor([], { projectId: PROJECT_ID, scope: "project" });

    expect(markup).toContain("every worker on this project");
    expect(markup).not.toContain("every agent in this workspace");
  });

  /**
   * Two providers, two mechanisms, and neither is overstated: Codex reads these
   * folders directly and Claude is handed a copy composed for the run. A person
   * installing a skill is relying on one of those, and which one decides what
   * "it did not load" means later.
   */
  test("both providers are named, and how each is reached", () => {
    const markup = markupFor([]);

    expect(markup).toContain("Codex runs read these directly");
    expect(markup).toContain("composed into it");
  });

  test("a directory with nothing installed says so rather than drawing an empty list", () => {
    const markup = markupFor([]);

    expect(markup).toContain("No skills installed");
  });
});

/**
 * The lock and the tree can disagree, because a person can delete either half
 * of a skill in the file browser and nothing else in the system will mention it
 * again. Both states have to be named, and they are not the same state: no
 * folder means the skill reaches nothing, no link means it reaches one provider
 * and not the other.
 */
describe("skillProblemOf", () => {
  test("a skill that is entirely on disk has nothing to report", () => {
    expect(skillProblemOf(skillOf({}))).toBeNull();
  });

  test("a lock row pointing at nothing says the run gets nothing", () => {
    const problem = skillProblemOf(skillOf({ present: false }));

    expect(problem?.badge).toBe("files gone");
    expect(problem?.sentence).toContain("nothing is handed to a run");
    expect(problem?.severe).toBe(true);
  });

  test("files with no link beside them say which half is missing, and name it", () => {
    const problem = skillProblemOf(skillOf({ linked: false }));

    expect(problem?.badge).toBe("no link");
    expect(problem?.sentence).toContain(".claude/skills/writing");
    expect(problem?.severe).toBe(false);
  });

  /** A skill whose folder is gone has no link either, and the folder is the thing to say. */
  test("a skill missing both halves is reported by the one that matters", () => {
    expect(
      skillProblemOf(skillOf({ linked: false, present: false }))?.badge
    ).toBe("files gone");
  });
});
