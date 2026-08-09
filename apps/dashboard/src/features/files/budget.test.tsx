/**
 * The reading that has to be right or nothing else on this screen matters.
 *
 * A run collects instruction files from every level of its tree and spends one
 * budget across them, root first, dropping what does not fit. The truncation
 * reaches nobody: the headless runner filters the only log line that mentions
 * it. So this panel is the whole warning, and a reading that measured one file
 * at a time would tell somebody their rules fit while a task's own brief is
 * being dropped.
 *
 * Rendered to static markup rather than through a browser: what is checked is
 * the number and the sentences drawn for a given tree, and that is settled by
 * the tree.
 */

import { describe, expect, test } from "bun:test";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { FileEntry } from "@workspace/api";
import {
  INSTRUCTION_BUDGET_WARN_BYTES,
  ProjectId,
  ScopePath,
  TaskId,
} from "@workspace/domain";
import { Schema } from "effect";
import { renderToStaticMarkup } from "react-dom/server";
import { keys } from "@/api/keys";
import { InstructionBudget } from "@/features/files/budget";

const TASK_ID = TaskId.make("6f1a0b4e-0000-4000-8000-0000000000aa");
const PROJECT_ID = ProjectId.make("6f1a0b4e-0000-4000-8000-0000000000bb");

/** The file every case here is about: a scope's own rules, at its root. */
const RULES = Schema.decodeUnknownSync(ScopePath)("AGENTS.md");

/** Just over a third of the budget: spare on its own, and not in company. */
const THIRD = Math.round(INSTRUCTION_BUDGET_WARN_BYTES * 0.35);

/** One root listing holding a single instruction file of a given size. */
const rulesOf = (bytes: number): readonly FileEntry[] => [
  {
    bytes,
    ext: "md",
    kind: "file",
    modifiedAt: null,
    name: "AGENTS.md",
    path: "AGENTS.md",
    target: null,
    targetOutsideScope: false,
  },
];

interface Scene {
  /** The size of what is in the editor's box, which is what the reading is about. */
  readonly draftBytes: number;
  /** Root listings by scope address, as the tree would already have fetched them. */
  readonly roots: Readonly<Record<string, readonly FileEntry[]>>;
  /** Absent leaves the task list unfetched, which is a task with no project. */
  readonly withProject?: boolean;
}

const markupFor = ({ draftBytes, roots, withProject = true }: Scene) => {
  const queryClient = new QueryClient();
  for (const [address, entries] of Object.entries(roots)) {
    queryClient.setQueryData(keys.scopeListing(address, null), entries);
  }
  queryClient.setQueryData(
    keys.tasks(),
    withProject ? [{ id: TASK_ID, projectId: PROJECT_ID }] : []
  );

  return renderToStaticMarkup(
    <QueryClientProvider client={queryClient}>
      <InstructionBudget
        draftBytes={draftBytes}
        path={RULES}
        scope={{ scope: "task", taskId: TASK_ID }}
      />
    </QueryClientProvider>
  );
};

describe("InstructionBudget", () => {
  /**
   * The bug this replaced. Three documents at roughly a third each all read
   * "spare" when they are measured one at a time, and together they are over
   * the budget the run actually spends.
   */
  test("levels that each look spare are over the budget together", () => {
    const markup = markupFor({
      draftBytes: THIRD,
      roots: {
        [`project:${PROJECT_ID}`]: rulesOf(THIRD),
        [`task:${TASK_ID}`]: rulesOf(THIRD),
        workspace: rulesOf(THIRD),
      },
    });

    expect(markup).toContain("Over the budget");
    expect(markup).toContain("34 kB of 32 kB");
  });

  test("every level that makes up the total is named beside it", () => {
    const markup = markupFor({
      draftBytes: 1000,
      roots: {
        [`project:${PROJECT_ID}`]: rulesOf(2000),
        [`task:${TASK_ID}`]: rulesOf(1000),
        workspace: rulesOf(4000),
      },
    });

    expect(markup).toContain("Workspace");
    expect(markup).toContain("Project");
    expect(markup).toContain("Task");
    expect(markup).toContain("7 kB of 32 kB");
  });

  /** What a person about to shorten something needs: which file goes first. */
  test("the deepest level is named as the one that is dropped first", () => {
    const markup = markupFor({
      draftBytes: 1000,
      roots: {
        [`project:${PROJECT_ID}`]: rulesOf(1000),
        [`task:${TASK_ID}`]: rulesOf(1000),
        workspace: rulesOf(1000),
      },
    });

    expect(markup).toContain("the task file is dropped first");
  });

  /**
   * The draft replaces the file on disk rather than being added to it. The
   * number only helps before the save, and a tally that counted both would
   * double whatever is being typed.
   */
  test("what is in the box replaces what is on disk at the same path", () => {
    const markup = markupFor({
      draftBytes: 5000,
      roots: {
        [`project:${PROJECT_ID}`]: [],
        [`task:${TASK_ID}`]: rulesOf(1000),
        workspace: [],
      },
    });

    expect(markup).toContain("5 kB of 32 kB");
  });

  /**
   * A total missing a level reads low, and low is the reading that gets
   * somebody's rules dropped — so a project that is not in the chain is said
   * rather than quietly left out.
   */
  test("a task whose project is unknown counts only what it is sure of", () => {
    const markup = markupFor({
      draftBytes: 1000,
      roots: { [`task:${TASK_ID}`]: rulesOf(1000), workspace: rulesOf(2000) },
      withProject: false,
    });

    expect(markup).toContain("3 kB of 32 kB");
    expect(markup).not.toContain("Project");
  });
});
