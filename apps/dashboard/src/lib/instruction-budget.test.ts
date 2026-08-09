/**
 * The one number on this screen that is not decoration.
 *
 * A run's instruction files share one budget spent from the top of the tree
 * down, and what falls off the end is the deepest, most specific document. The
 * truncation reaches nobody: the runner filters the only log line that mentions
 * it. So the reading drawn beside the editor is the whole warning, and a wrong
 * one is worse than none — it would tell somebody their rules fit while a task's
 * own brief is being dropped.
 */

import { describe, expect, test } from "bun:test";
import { INSTRUCTION_BUDGET_WARN_BYTES } from "@workspace/domain";
import {
  type BudgetFile,
  budgetPercentOf,
  budgetPressureOf,
  budgetTallyOf,
  byteLengthOf,
  isInstructionFile,
} from "@/lib/instruction-budget";

describe("INSTRUCTION_BUDGET_WARN_BYTES", () => {
  /**
   * Pinned, because the number is a claim about somebody else's software. The
   * host warns at it and the browser draws against it from one definition now,
   * so this test is what makes Codex changing its default a deliberate edit
   * rather than a screen that quietly reads the wrong limit.
   */
  test("is the 32 KiB a default Codex truncates at", () => {
    expect(INSTRUCTION_BUDGET_WARN_BYTES).toBe(32_768);
  });
});

describe("isInstructionFile", () => {
  test("both names a run reads its rules from count, at any depth", () => {
    expect(isInstructionFile("AGENTS.md")).toBe(true);
    expect(isInstructionFile("worker/api/CLAUDE.md")).toBe(true);
  });

  test("an ordinary document does not spend the budget", () => {
    expect(isInstructionFile("notes/research-2026-08.md")).toBe(false);
    expect(isInstructionFile("AGENTS.md.bak")).toBe(false);
  });
});

describe("byteLengthOf", () => {
  test("a character that costs several bytes is counted as several", () => {
    expect(byteLengthOf("plain")).toBe(5);
    expect(byteLengthOf("é")).toBe(2);
    expect(byteLengthOf("→")).toBe(3);
  });
});

describe("budgetPressureOf", () => {
  test("a short rules file leaves the levels below it room", () => {
    expect(budgetPressureOf(4096)).toBe("spare");
  });

  test("one file holding half the shared budget is already worth saying", () => {
    expect(budgetPressureOf(INSTRUCTION_BUDGET_WARN_BYTES / 2)).toBe(
      "crowding"
    );
  });

  test("at the budget the deepest file is already being dropped", () => {
    expect(budgetPressureOf(INSTRUCTION_BUDGET_WARN_BYTES)).toBe("over");
    expect(budgetPressureOf(INSTRUCTION_BUDGET_WARN_BYTES * 3)).toBe("over");
  });
});

describe("budgetPercentOf", () => {
  test("a bar never draws past its own track", () => {
    expect(budgetPercentOf(INSTRUCTION_BUDGET_WARN_BYTES * 4)).toBe(100);
  });

  test("half the budget reads as half", () => {
    expect(budgetPercentOf(INSTRUCTION_BUDGET_WARN_BYTES / 2)).toBe(50);
  });
});

/** One file at one level, with only the fields a case is about spelled out. */
const fileOf = (over: Partial<BudgetFile>): BudgetFile => ({
  bytes: 0,
  level: "Workspace",
  name: "AGENTS.md",
  open: false,
  ...over,
});

describe("budgetTallyOf", () => {
  /**
   * The reason this function exists. A run spends one budget across every level
   * of its tree, so two documents that each read "spare" on their own can be
   * over it together — and the screen that measured them one at a time told
   * nobody.
   */
  test("two files that each look spare are over the budget together", () => {
    const each = INSTRUCTION_BUDGET_WARN_BYTES * 0.6;

    expect(budgetPressureOf(each)).toBe("crowding");
    expect(
      budgetTallyOf([
        fileOf({ bytes: each }),
        fileOf({ bytes: each, level: "Task" }),
      ]).pressure
    ).toBe("over");
  });

  test("the deepest level is named as the one a truncation takes first", () => {
    const tally = budgetTallyOf([
      fileOf({ bytes: 100 }),
      fileOf({ bytes: 200, level: "Project" }),
      fileOf({ bytes: 300, level: "Task" }),
    ]);

    expect(tally.totalBytes).toBe(600);
    expect(tally.droppedFirst).toBe("Task");
  });

  /**
   * A pair at one level is one document under two names, not a deeper level —
   * so there is nothing to name as "dropped first", and naming one anyway would
   * tell somebody to shorten a file that is no more at risk than its twin.
   */
  test("a tree of one level names nothing as the first to go", () => {
    const tally = budgetTallyOf([
      fileOf({ bytes: 100 }),
      fileOf({ bytes: 20, name: "CLAUDE.md" }),
    ]);

    expect(tally.droppedFirst).toBeNull();
  });

  test("an empty tree costs nothing", () => {
    expect(budgetTallyOf([]).totalBytes).toBe(0);
    expect(budgetTallyOf([]).droppedFirst).toBeNull();
  });
});
