/**
 * The one number on this screen that is not decoration, drawn over the whole
 * tree rather than over one file of it.
 *
 * A run collects instruction files from the top of its tree down to its working
 * directory and spends **one** budget across them, root first. Past the budget
 * the rest is dropped, so the deepest and most specific document — a task's own
 * brief — is the first thing to go, and nothing tells the person who caused it:
 * the only signal is a log line the headless runner filters out.
 *
 * A per-file reading misleads exactly that person. Two documents at 40% each
 * both read "spare" while together they crowd the task out. So this adds up the
 * levels a run really walks, names the files that make up the total, and says
 * which one goes first.
 *
 * Nothing here fetches anything new. Each level's root listing is a query the
 * tree already uses, and the size of the file being edited comes from the draft
 * in the box — because the number only helps before the save.
 */

import { useQueries, useQuery } from "@tanstack/react-query";
import type { FileEntry } from "@workspace/api";
import {
  type FileScope,
  INSTRUCTION_BUDGET_WARN_BYTES,
  isInstructionFileName,
  type ScopePath,
} from "@workspace/domain";
import { Progress } from "@workspace/ui/components/progress";
import { cn } from "@workspace/ui/lib/utils";
import { useMemo } from "react";
import { scopeListingQuery } from "@/api/files";
import { tasksQuery } from "@/api/tasks";
import { instructionChainOf, SCOPE_LEVELS } from "@/features/files/scopes";
import { formatBytes } from "@/lib/format";
import {
  type BudgetFile,
  budgetPercentOf,
  budgetTallyOf,
  TALLY_SENTENCES,
} from "@/lib/instruction-budget";
import { nameOf, parentOf } from "@/lib/scope-path";

/** The tone the reading is drawn in, which is the only thing that changes with it. */
const PRESSURE_TONES = {
  crowding: "[&_[data-slot=progress-indicator]]:bg-amber-500",
  over: "[&_[data-slot=progress-indicator]]:bg-destructive",
  spare: null,
} as const;

/**
 * The instruction files at one level's own root.
 *
 * Only the root: a run walks the directories between its scopes, and a document
 * filed inside a subfolder of one of them is not on that walk unless the walk
 * happens to pass through it. Links are left out — a `CLAUDE.md` pointing at the
 * `AGENTS.md` beside it is one document, and counting the link's own bytes as a
 * second would inflate every level that uses the pairing this screen recommends.
 */
const filesAt = (level: string, entries: readonly FileEntry[]) =>
  entries
    .filter(
      (entry) => entry.kind === "file" && isInstructionFileName(entry.name)
    )
    .map(
      (entry) =>
        ({
          bytes: entry.bytes ?? 0,
          level,
          name: entry.name,
          open: false,
        }) satisfies BudgetFile
    );

interface DraftFile {
  readonly bytes: number;
  readonly level: string;
  readonly path: ScopePath;
}

/**
 * The same list with the open file's draft size in place of the one on disk.
 *
 * Substituted rather than added when the level and the name match, and appended
 * otherwise — a file below the scope's root, or one created since the listing
 * was read, still has to be counted. Counting it twice would overstate; leaving
 * it out would understate, and understating is the failure this whole reading
 * exists to prevent.
 */
const withDraft = (files: readonly BudgetFile[], draft: DraftFile) => {
  const name = parentOf(draft.path) === null ? nameOf(draft.path) : draft.path;
  const open = { bytes: draft.bytes, level: draft.level, name, open: true };
  const at = files.findIndex(
    (file) => file.level === draft.level && file.name === name
  );
  return at === -1
    ? [...files, open]
    : files.map((file, index) => (index === at ? open : file));
};

interface BudgetProps {
  /** The size of what is in the box, which is what the reading is about. */
  readonly draftBytes: number;
  readonly path: ScopePath;
  readonly scope: FileScope;
}

/**
 * How much of a run's instruction budget this file's whole tree has taken.
 *
 * The chain of levels comes from the tasks already in the cache, so a task page
 * that has not loaded its list yet reads one level short. That is called out
 * rather than hidden: a tally missing a level reads low, and low is the reading
 * that gets somebody's rules dropped.
 */
export const InstructionBudget = ({ draftBytes, path, scope }: BudgetProps) => {
  const tasks = useQuery(tasksQuery());

  const chain = useMemo(
    () => instructionChainOf({ scope, tasks: tasks.data ?? [] }),
    [scope, tasks.data]
  );

  const listings = useQueries({
    queries: chain.map((one) => scopeListingQuery(one, null)),
  });

  const onDisk = chain.flatMap((one, index) =>
    filesAt(SCOPE_LEVELS[one.scope], listings[index]?.data ?? [])
  );
  const tally = budgetTallyOf(
    withDraft(onDisk, {
      bytes: draftBytes,
      level: SCOPE_LEVELS[scope.scope],
      path,
    })
  );

  const reading = listings.some((listing) => listing.isPending)
    ? "still reading the other levels"
    : TALLY_SENTENCES[tally.pressure];

  return (
    <div className="flex flex-col gap-1.5 border-border border-b px-3 py-2">
      <Progress
        aria-label="Instruction budget used"
        className={cn("gap-1", PRESSURE_TONES[tally.pressure])}
        value={budgetPercentOf(tally.totalBytes)}
      />
      <p className="text-muted-foreground text-xs">
        <span className="tabular-nums">
          {formatBytes(tally.totalBytes)} of{" "}
          {formatBytes(INSTRUCTION_BUDGET_WARN_BYTES)}
        </span>{" "}
        across every level a run reads — {reading}
      </p>

      <ul className="flex flex-col gap-0.5">
        {tally.files.map((file) => (
          <li
            className={cn(
              "flex items-baseline justify-between gap-2 text-xs",
              file.open ? "font-medium" : "text-muted-foreground"
            )}
            key={`${file.level}/${file.name}`}
          >
            <span className="min-w-0 truncate">
              <span className="text-muted-foreground">{file.level}</span>{" "}
              <span className="font-mono">{file.name}</span>
            </span>
            <span className="shrink-0 tabular-nums">
              {formatBytes(file.bytes)}
            </span>
          </li>
        ))}
      </ul>

      <p className="text-muted-foreground text-xs">
        {tally.droppedFirst === null
          ? "Every level below this one adds to the same total, and the deepest of them is what a truncation takes first."
          : `Past the budget the ${tally.droppedFirst.toLowerCase()} file is dropped first and the workspace's survives, which is backwards from what the nesting is for.`}
        {/*
          A worker's tree always ends at a task, and this screen is open on a
          level above it — so the total on screen is the floor rather than the
          figure, and saying so is the difference between a warning and a
          number somebody trusts.
        */}
        {scope.scope === "workspace" || scope.scope === "project"
          ? " Every task under this adds its own file below these, and that one goes first."
          : null}
      </p>

      {tasks.isPending && scope.scope === "task" ? (
        <p className="text-muted-foreground text-xs">
          The project this task belongs to has not loaded, so its rules are not
          in this total yet.
        </p>
      ) : null}
    </div>
  );
};
