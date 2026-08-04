import { describe, expect, test } from "bun:test";
import type { RunId } from "@workspace/domain";
import { RUN_LABEL } from "./docker-argv";
import {
  type LabelledContainer,
  orphanListArgs,
  orphansOf,
  parseOrphanList,
} from "./reap";

const RUN_A = "019fc24e-3ba5-7d73-a69f-9626c0ee6fd2" as RunId;
const RUN_B = "019fc24f-cd36-7b60-90bb-c821a1bbef7d" as RunId;

const held = (runId: RunId): LabelledContainer => ({
  name: `atm-${runId}-d1806594`,
  runId,
});

describe("orphanListArgs", () => {
  test("asks for stopped and running alike", () => {
    expect(orphanListArgs()).toContain("-a");
  });

  test("matches the label this system writes, never a name prefix", () => {
    const args = orphanListArgs().join(" ");
    expect(args).toContain(`label=${RUN_LABEL}`);
    expect(args).not.toContain("name=atm-");
  });
});

describe("parseOrphanList", () => {
  test("reads a name and the run it was started for", () => {
    const rows = parseOrphanList(`atm-${RUN_A}-d1806594\t${RUN_A}\n`);
    expect(rows).toEqual([{ name: `atm-${RUN_A}-d1806594`, runId: RUN_A }]);
  });

  test("is empty for the daemon that is holding nothing", () => {
    expect(parseOrphanList("")).toEqual([]);
    expect(parseOrphanList("\n\n")).toEqual([]);
  });

  test("drops a row it cannot attribute rather than guessing at one", () => {
    // A container carrying the label with no value is not this system's to
    // remove: the whole safety of the sweep is that it removes nothing it
    // cannot name a run for.
    expect(parseOrphanList("atm-orphan\t\nno-tab-here\n")).toEqual([]);
  });
});

describe("orphansOf", () => {
  test("a container whose run is over is an orphan", () => {
    expect(orphansOf({ held: [held(RUN_A)], live: new Set() })).toEqual([
      held(RUN_A),
    ]);
  });

  test("a live run's container is left alone — it may be this very process's", () => {
    expect(orphansOf({ held: [held(RUN_A)], live: new Set([RUN_A]) })).toEqual(
      []
    );
  });

  test("one live run does not protect another run's leftovers", () => {
    expect(
      orphansOf({ held: [held(RUN_A), held(RUN_B)], live: new Set([RUN_A]) })
    ).toEqual([held(RUN_B)]);
  });
});
