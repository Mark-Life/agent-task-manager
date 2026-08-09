/**
 * What is worth testing in a backup script is the part that decides, not the
 * part that copies bytes. Whether a week is named right at a year boundary,
 * which sets a prune deletes, and whether a row-count comparison notices a
 * table that vanished are all decisions this file can hold still. Whether
 * `pg_dump` produced a restorable archive is not — that is
 * `bun run backup:verify`, against a real Postgres.
 */

import { describe, expect, test } from "bun:test";
import {
  compareCounts,
  humanBytes,
  isoWeek,
  parseCounts,
  parseDatabaseUrl,
  partitionByAge,
  scratchDatabaseName,
  tocEntryCount,
  utcDay,
} from "./backup";

describe("utcDay", () => {
  test("names the UTC day, not the local one", () => {
    expect(utcDay(new Date("2026-08-09T23:30:00Z"))).toBe("2026-08-09");
    expect(utcDay(new Date("2026-08-10T00:30:00Z"))).toBe("2026-08-10");
  });
});

describe("isoWeek", () => {
  test("weeks start on Monday", () => {
    expect(isoWeek(new Date("2026-08-09T00:00:00Z"))).toBe("2026-W32"); // Sunday
    expect(isoWeek(new Date("2026-08-10T00:00:00Z"))).toBe("2026-W33"); // Monday
  });

  test("a January day can belong to the previous year's last week", () => {
    // 2027-01-01 is a Friday, so ISO 8601 puts it in the week that started
    // 2026-12-28. Naming it 2027-W01 would sort it before every 2026 set and
    // the prune would delete the wrong one.
    expect(isoWeek(new Date("2027-01-01T00:00:00Z"))).toBe("2026-W53");
    expect(isoWeek(new Date("2027-01-04T00:00:00Z"))).toBe("2027-W01");
  });

  test("a December day can belong to the next year's first week", () => {
    expect(isoWeek(new Date("2024-12-30T00:00:00Z"))).toBe("2025-W01");
  });

  test("always two digits, so lexical order is chronological order", () => {
    expect(isoWeek(new Date("2026-03-02T00:00:00Z"))).toBe("2026-W10");
    expect(isoWeek(new Date("2026-01-05T00:00:00Z"))).toBe("2026-W02");
  });
});

/** The two names a set can have, as `backup.ts` matches them. */
const DAY_PATTERN = /^\d{4}-\d{2}-\d{2}$/;
const WEEK_PATTERN = /^\d{4}-W\d{2}$/;

describe("partitionByAge", () => {
  const days = [
    "2026-08-01",
    "2026-08-02",
    "2026-08-03",
    "2026-08-04",
    "2026-08-05",
  ];

  test("keeps the newest, drops the rest", () => {
    const { drop, keep } = partitionByAge({
      keep: 2,
      names: days,
      pattern: DAY_PATTERN,
    });
    expect(keep).toEqual(["2026-08-05", "2026-08-04"]);
    expect(drop).toEqual(["2026-08-01", "2026-08-02", "2026-08-03"]);
  });

  test("fewer sets than the window drops nothing", () => {
    const { drop } = partitionByAge({
      keep: 14,
      names: days,
      pattern: DAY_PATTERN,
    });
    expect(drop).toEqual([]);
  });

  test("a name it does not recognise is never deleted", () => {
    // `.staging-2026-08-06`, `.lock` and anything an operator left behind. A
    // prune that deletes what it cannot parse eventually deletes the wrong
    // thing.
    const { drop, keep } = partitionByAge({
      keep: 1,
      names: [...days, ".staging-2026-08-06", "keep-me", ".lock"],
      pattern: DAY_PATTERN,
    });
    expect(keep).toEqual(["2026-08-05"]);
    expect(drop).not.toContain("keep-me");
    expect(drop).not.toContain(".lock");
    expect(drop).not.toContain(".staging-2026-08-06");
  });

  test("an unsorted directory listing is still ordered by age", () => {
    const { keep } = partitionByAge({
      keep: 2,
      names: ["2026-08-03", "2026-08-01", "2026-08-05", "2026-08-02"],
      pattern: DAY_PATTERN,
    });
    expect(keep).toEqual(["2026-08-05", "2026-08-03"]);
  });

  test("week stamps sort the same way", () => {
    const { drop, keep } = partitionByAge({
      keep: 2,
      names: ["2026-W09", "2026-W10", "2026-W08", "2025-W52"],
      pattern: WEEK_PATTERN,
    });
    expect(keep).toEqual(["2026-W10", "2026-W09"]);
    expect(drop).toEqual(["2025-W52", "2026-W08"]);
  });
});

describe("parseDatabaseUrl", () => {
  test("splits the parts libpq wants as environment variables", () => {
    expect(
      parseDatabaseUrl(
        "postgres://atm:s3cret@127.0.0.1:5433/agent_task_manager"
      )
    ).toEqual({
      database: "agent_task_manager",
      host: "127.0.0.1",
      password: "s3cret",
      port: "5433",
      user: "atm",
    });
  });

  test("a password with URL-escaped punctuation comes back as written", () => {
    expect(
      parseDatabaseUrl("postgres://u:p%40ss%3Aword@db:5432/atm").password
    ).toBe("p@ss:word");
  });

  test("no port means the default", () => {
    expect(parseDatabaseUrl("postgres://u:p@db/atm").port).toBe("5432");
  });

  test("a URL naming no database is refused rather than dumping the wrong one", () => {
    expect(() => parseDatabaseUrl("postgres://u:p@db:5432/")).toThrow();
  });
});

describe("parseCounts", () => {
  test("reads psql's unaligned output", () => {
    expect(parseCounts("task,84\nrun,169\nrun_event,21788\n")).toEqual({
      run: 169,
      run_event: 21_788,
      task: 84,
    });
  });

  test("blank lines and psql's trailing newline are not tables", () => {
    expect(parseCounts("\ntask,84\n\n")).toEqual({ task: 84 });
  });

  test("a zero-row table is a table, not an absence", () => {
    expect(parseCounts("audit,0\n")).toEqual({ audit: 0 });
  });
});

describe("compareCounts", () => {
  const expected = { run: 169, task: 84 };

  test("identical counts are no mismatch", () => {
    expect(compareCounts({ expected, restored: { ...expected } })).toEqual([]);
  });

  test("a row lost in the restore is reported", () => {
    expect(
      compareCounts({ expected, restored: { run: 169, task: 83 } })
    ).toEqual([{ expected: 84, restored: 83, table: "task" }]);
  });

  test("a table the restore did not create at all is reported", () => {
    // The failure mode a `pg_restore` exit code alone can miss, and the reason
    // the comparison is over the union of both sides rather than over one.
    expect(compareCounts({ expected, restored: { run: 169 } })).toEqual([
      { expected: 84, restored: null, table: "task" },
    ]);
  });

  test("a table the manifest never knew about is reported too", () => {
    expect(
      compareCounts({ expected, restored: { ...expected, stowaway: 1 } })
    ).toEqual([{ expected: null, restored: 1, table: "stowaway" }]);
  });
});

describe("tocEntryCount", () => {
  test("counts archive entries and not pg_restore's comment header", () => {
    const listing = [
      ";",
      "; Archive created at 2026-08-09 05:59:59 UTC",
      ";     dbname: agent_task_manager",
      ";",
      "200; 1259 16385 TABLE public task atm",
      "201; 1259 16390 TABLE public run atm",
      "",
    ].join("\n");
    expect(tocEntryCount(listing)).toBe(2);
  });
});

describe("humanBytes", () => {
  test("bytes stay whole and larger units get one decimal", () => {
    expect(humanBytes(512)).toBe("512 B");
    expect(humanBytes(3_141_141)).toBe("3.0 MB");
    expect(humanBytes(89_620_000)).toBe("85.5 MB");
  });
});

describe("scratchDatabaseName", () => {
  test("is a legal identifier whatever the set was called", () => {
    expect(scratchDatabaseName({ pid: 4321, setName: "weekly_2026-W32" })).toBe(
      "atm_restore_check_weekly_2026_w32_4321"
    );
  });

  test("two runs at once do not pick the same name", () => {
    expect(
      scratchDatabaseName({ pid: 1, setName: "daily_2026-08-09" })
    ).not.toBe(scratchDatabaseName({ pid: 2, setName: "daily_2026-08-09" }));
  });
});
