/**
 * How close a run's instruction files are to the size at which it stops being
 * given all of them.
 *
 * The whole tree, not one file of it. A budget drawn per file is worse than
 * none: two documents at 40% each both read "spare" while together they push the
 * deepest one out.
 *
 * Codex collects every `AGENTS.md` from the top of the tree down to the working
 * directory and spends one combined budget, root first. Past the budget the
 * rest is dropped — so the deepest and most specific document, the task's own,
 * is the first thing to go, which is backwards from what the nesting is for.
 * The truncation is silent: the only signal is a log line the headless runner
 * filters out.
 *
 * That is the whole reason this exists. A person editing house rules in a
 * browser has no other way to learn they are about to cost the deepest file its
 * place, so the number is drawn beside the box they are typing into, live,
 * against the same limit the host warns at.
 *
 * The limit and the two filenames come from `@workspace/domain`, which is where
 * the host's own measurement of a whole run's tree reads them from too. The
 * package that does that measuring reaches a filesystem and a container daemon
 * and cannot be bundled for a browser, so the vocabulary the two ends share
 * sits below both of them — and Codex moving its default is one edit rather
 * than two that can quietly disagree.
 */

import {
  INSTRUCTION_BUDGET_WARN_BYTES,
  isInstructionFileName,
} from "@workspace/domain";
import { nameOf } from "@/lib/scope-path";

/** Whether a path is one of the files a run reads its instructions from. */
export const isInstructionFile = (path: string) =>
  isInstructionFileName(nameOf(path));

/**
 * The size of some text in bytes, which is not its length in characters.
 *
 * Both limits this app checks against — the budget and the routes' own cap —
 * are counted in bytes, and one emoji or one accented letter costs more than
 * one of them. Measuring the string's length would tell a person they are under
 * a limit they have already passed.
 */
export const byteLengthOf = (text: string) =>
  new TextEncoder().encode(text).length;

/** The whole budget, as the bar's own scale reads it. */
const WHOLE_BUDGET = 100;

/**
 * How much of the budget one file has taken, capped at a whole one. Over the
 * budget the honest number is unbounded, and a bar that draws past its own
 * track says nothing the sentence beside it does not.
 */
export const budgetPercentOf = (bytes: number) =>
  Math.min(
    WHOLE_BUDGET,
    Math.round((bytes / INSTRUCTION_BUDGET_WARN_BYTES) * WHOLE_BUDGET)
  );

/**
 * Three readings, because there are three things to do about it: nothing, watch
 * the other levels, and shorten this file now.
 *
 * `crowding` starts at half rather than at some fraction closer to the edge —
 * the budget is shared with every other level of the tree, so one file holding
 * half of it has already left the rest of them short.
 */
export const BUDGET_PRESSURES = ["spare", "crowding", "over"] as const;

/** Which of the three readings a size falls under. */
export type BudgetPressure = (typeof BUDGET_PRESSURES)[number];

/** Where a file of this size stands against the shared budget. */
export const budgetPressureOf = (bytes: number): BudgetPressure => {
  if (bytes >= INSTRUCTION_BUDGET_WARN_BYTES) {
    return "over";
  }
  return bytes >= INSTRUCTION_BUDGET_WARN_BYTES / 2 ? "crowding" : "spare";
};

/**
 * What each reading means, said as the consequence rather than as a level.
 *
 * "Crowding" tells a reader nothing; "the levels below this one have half the
 * budget left" tells them what their next edit costs somebody else.
 *
 * One file at a time. Use {@link TALLY_SENTENCES} wherever the whole tree can be
 * added up, which is the honest reading — see {@link budgetTallyOf}.
 */
export const BUDGET_SENTENCES: Record<BudgetPressure, string> = {
  crowding:
    "This one file has taken half the budget a whole run's instruction files share. The levels below it — a project's rules, a task's — are what gets dropped first.",
  over: "This file alone is over the budget a run's instruction files share, and a default Codex truncates from the deepest file up. Shorten it, or the task's own rules never arrive.",
  spare: "Well inside the budget a run's instruction files share.",
};

/** The same three readings, for the whole tree rather than for one file of it. */
export const TALLY_SENTENCES: Record<BudgetPressure, string> = {
  crowding:
    "Half the budget spent. What is left has to cover every level below this one.",
  over: "Over the budget. A default Codex spends it from the top down and drops the rest, so the deepest file in this list is the one that never arrives.",
  spare: "Room left for the levels below.",
};

/**
 * One instruction file a run is handed, and which level of the tree it sits at.
 *
 * `level` rather than a scope address, because what decides whether a file
 * survives is its depth: the budget is spent from the top of the tree down, so
 * the last row of a tally is the first thing dropped.
 */
export interface BudgetFile {
  readonly bytes: number;
  /** What the level is called on screen — "Workspace", "Project", "Task". */
  readonly level: string;
  /** The file, named as the person editing it would name it. */
  readonly name: string;
  /** True for the file in the editor, whose size is the draft rather than the disk. */
  readonly open: boolean;
}

/**
 * What a run's whole instruction tree comes to, which is the only number worth
 * drawing.
 *
 * One file's size against the budget is the reading this screen used to show,
 * and it misleads exactly the person it is for: a run walks every level of its
 * tree against **one** combined budget, so two files at 40% each both read
 * "spare" while together they crowd out the task's own rules. Everything here is
 * arithmetic over listings the tree has already fetched.
 *
 * Files arrive shallowest first and stay in that order, because that is the
 * order the budget is spent in and the order the answer has to be read in.
 */
export const budgetTallyOf = (files: readonly BudgetFile[]) => {
  const totalBytes = files.reduce((sum, file) => sum + file.bytes, 0);
  const deepest = files.at(-1)?.level ?? null;
  return {
    /**
     * The level a truncation takes first, and null when every file in the tally
     * is at one level — there is nothing to name as "first" when the whole tree
     * is one directory.
     */
    droppedFirst:
      deepest !== null && files.some((file) => file.level !== deepest)
        ? deepest
        : null,
    files,
    pressure: budgetPressureOf(totalBytes),
    totalBytes,
  };
};
