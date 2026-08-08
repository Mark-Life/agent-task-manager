/**
 * How close an instruction file is to the size at which a run stops being given
 * all of it.
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
 */
export const BUDGET_SENTENCES: Record<BudgetPressure, string> = {
  crowding:
    "This one file has taken half the budget a whole run's instruction files share. The levels below it — a project's rules, a task's — are what gets dropped first.",
  over: "This file alone is over the budget a run's instruction files share, and a default Codex truncates from the deepest file up. Shorten it, or the task's own rules never arrive.",
  spare: "Well inside the budget a run's instruction files share.",
};
