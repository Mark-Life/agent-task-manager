/**
 * What this file defends: one text, two deliveries.
 *
 * The rules that live on disk are written into the tree by the loop and inlined
 * into a prompt when a run has no tree to read them from. Both readings have to
 * be the same words — a document that says one thing to a container run and a
 * prompt that says another is the drift that moving the text out of the build
 * was meant to end. The seeded documents are therefore asserted to be composed
 * of the constants the prompts inline, not to match a copy written out here.
 */

import { describe, expect, test } from "bun:test";
import {
  MANAGER_ANSWER_RULES,
  MANAGER_INSTRUCTIONS,
  MESSAGE_SHAPE_RULES,
  WORKSPACE_INSTRUCTIONS,
  WORKSPACE_RULES,
  WRITING_RULES,
} from "./instructions";
import { MANAGER_RULES, WORKER_RULES } from "./rules";

describe("the seeded documents", () => {
  test("carry the same constants a prompt inlines, rather than a second copy", () => {
    expect(WORKSPACE_INSTRUCTIONS).toContain(WORKSPACE_RULES);
    expect(WORKSPACE_RULES).toContain(WRITING_RULES);
    expect(WORKSPACE_RULES).toContain(MESSAGE_SHAPE_RULES);
    expect(MANAGER_INSTRUCTIONS).toContain(MANAGER_ANSWER_RULES);
  });

  /**
   * A person opening `CLAUDE.md` and editing it there loses the edit into a
   * one-line import. The pair is only safe if the file that holds the text says
   * which of the two to edit.
   */
  test("say which of the pair holds the text", () => {
    for (const document of [WORKSPACE_INSTRUCTIONS, MANAGER_INSTRUCTIONS]) {
      expect(document).toContain("`CLAUDE.md` beside this file is one line");
      expect(document).toContain("This is the file to edit");
    }
  });

  /**
   * The person who opens the workspace document is the person who will add to
   * it, and their first question is which level their rule belongs at.
   */
  test("say what each level of the tree below them is for", () => {
    expect(WORKSPACE_INSTRUCTIONS).toContain("`manager/`");
    expect(WORKSPACE_INSTRUCTIONS).toContain("`worker/<project>/`");
    expect(WORKSPACE_INSTRUCTIONS).toContain("`worker/<project>/<task>/`");
  });

  /**
   * A seeded opinion about a language is a guess every run on every project
   * reads as though somebody had decided it. The heading exists so a person
   * knows where their own conventions go; the space under it stays empty.
   */
  test("leave the coding conventions empty and name the file they belong in", () => {
    expect(WORKSPACE_INSTRUCTIONS).toContain("## Coding conventions");
    expect(WORKSPACE_INSTRUCTIONS).toContain("Nothing here yet");
    expect(WORKSPACE_INSTRUCTIONS).toContain("worker/<project>/AGENTS.md");
    expect(WORKSPACE_INSTRUCTIONS).not.toContain("TypeScript");
  });
});

/**
 * The half that stayed in the build, checked from the other side: a rule a
 * mechanism enforces must not be sitting in a file an operator can delete.
 */
describe("what did not move", () => {
  test("keeps the rule the stop hook enforces out of the seeded text", () => {
    expect(WORKER_RULES).toContain("post a message on this task");
    expect(WORKSPACE_INSTRUCTIONS).not.toContain("post a message on this task");
  });

  test("keeps board policy out of the manager's seeded rules", () => {
    expect(MANAGER_RULES).toContain("tasks_delete");
    expect(MANAGER_INSTRUCTIONS).not.toContain("tasks_delete");
  });

  /**
   * The seeded text is one document for every run of an install, while the paths
   * are per run and a local turn's are the host's. A path named in a seeded rule
   * would send some run to a directory that does not exist — the container tree
   * is the one exception, and it is named as the layout it is rather than as
   * somewhere to write.
   */
  test("names no run's own directory in text every install shares", () => {
    expect(MANAGER_ANSWER_RULES).not.toContain("/workspace");
    expect(WORKSPACE_RULES).not.toContain("/workspace");
  });
});
