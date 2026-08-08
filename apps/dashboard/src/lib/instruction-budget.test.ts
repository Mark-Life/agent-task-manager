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
  budgetPercentOf,
  budgetPressureOf,
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
