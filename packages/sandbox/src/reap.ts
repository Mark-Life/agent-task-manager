/**
 * The containers a killed process left behind, and how to name them.
 *
 * Teardown is a release registered before the container starts, so every
 * ordinary ending removes it — success, failure, timeout and interrupt alike.
 * What a release cannot survive is its own process being killed outright: a
 * `SIGKILL` to the loop, a host that reboots, a check that kills a child to
 * prove what a crash leaves. The container outlives the only thing that was
 * committed to removing it.
 *
 * `docker run --rm` would close that gap and is deliberately not used: the exit
 * code and the kernel's OOM verdict are read back with `docker inspect` after
 * the container stops, and a daemon that has already deleted it leaves a run
 * whose ending is unknowable. A stray container is cheaper than a lost verdict.
 *
 * So the answer is a sweep, and the label is what makes it safe. Every container
 * this system starts carries {@link RUN_LABEL} with its run id, so the sweep
 * matches on a label nobody else writes rather than on a name prefix anyone
 * could take. Whether a match is an orphan is not a question this package can
 * answer — that is a database read — which is why everything here lists and
 * removes but never decides.
 */

import type { RunId } from "@workspace/domain";
import { RUN_LABEL } from "./docker-argv";

/** Separates the fields of one listed container. Tabs cannot occur in either. */
const FIELD_SEPARATOR = "\t";

/**
 * The argv that lists every container this system has started, running or not.
 *
 * `-a` on purpose. A stopped container is the ordinary leftover, and a running
 * one whose run is over is the expensive one — it is still holding a CPU for an
 * answer nobody will read.
 */
export const orphanListArgs = (): readonly string[] => [
  "ps",
  "-a",
  `--filter=label=${RUN_LABEL}`,
  `--format={{.Names}}${FIELD_SEPARATOR}{{.Label "${RUN_LABEL}"}}`,
];

/** One container the daemon is holding, and the run it was started for. */
export interface LabelledContainer {
  readonly name: string;
  /** Off the label rather than parsed out of the name, which is only a display. */
  readonly runId: RunId;
}

/**
 * The listing, as rows. A line missing either field is dropped rather than
 * guessed at: the whole safety of a sweep is that it never removes a container
 * it cannot attribute to a run.
 */
export const parseOrphanList = (
  stdout: string
): readonly LabelledContainer[] => {
  const rows: LabelledContainer[] = [];
  for (const line of stdout.split("\n")) {
    const [name, runId] = line.trim().split(FIELD_SEPARATOR);
    if (name !== undefined && name !== "" && runId !== undefined) {
      const trimmed = runId.trim();
      if (trimmed !== "") {
        rows.push({ name, runId: trimmed as RunId });
      }
    }
  }
  return rows;
};

/**
 * The containers to remove, given everything the daemon holds and the runs the
 * database still considers live.
 *
 * Pure, and separated from both sides for the reason the module note gives: one
 * half is a daemon and the other is a database, and the rule joining them is the
 * only part worth testing. A live run's container is left alone whatever state
 * it is in — that is a run in flight, possibly this very process's.
 */
export const orphansOf = (input: {
  readonly held: readonly LabelledContainer[];
  readonly live: ReadonlySet<RunId>;
}) => input.held.filter((container) => !input.live.has(container.runId));
