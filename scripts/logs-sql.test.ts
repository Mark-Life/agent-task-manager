/**
 * The `sql` view over a real ledger on disk and a real SQLite database — the
 * two things the view is made of, so there is nothing left to fake. What is not
 * covered here is the copy out of Postgres, which needs the database up;
 * `pgTablesIn` is tested instead, because deciding to connect is the part that
 * can be wrong without anyone noticing.
 */

import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  columnsOf,
  EVENTS_TABLE,
  ledgerRecords,
  loadTable,
  pgTablesIn,
  renderTable,
  runSqlView,
} from "./logs-sql";

/** A ledger directory holding one file per named service. */
const ledgerDir = (files: Readonly<Record<string, readonly unknown[]>>) => {
  const dir = mkdtempSync(join(tmpdir(), "logs-sql-"));
  const paths: string[] = [];
  for (const [service, rows] of Object.entries(files)) {
    const path = join(dir, `${service}.jsonl`);
    writeFileSync(path, rows.map((row) => JSON.stringify(row)).join("\n"));
    paths.push(path);
  }
  return paths;
};

const runRow = (fields: Readonly<Record<string, unknown>>) => ({
  event: "atm.run",
  phase: "end",
  ...fields,
});

/** Runs a query the way the command does and returns what it wrote. */
const query = async (files: readonly string[], sql: string | undefined) => {
  const out: string[] = [];
  const err: string[] = [];
  const write = process.stdout.write.bind(process.stdout);
  const writeErr = process.stderr.write.bind(process.stderr);
  process.stdout.write = ((chunk: string) => {
    out.push(chunk);
    return true;
  }) as typeof process.stdout.write;
  process.stderr.write = ((chunk: string) => {
    err.push(chunk);
    return true;
  }) as typeof process.stderr.write;
  try {
    const code = await runSqlView({ files, json: false, query: sql });
    return { code, err: err.join(""), out: out.join("") };
  } finally {
    process.stdout.write = write;
    process.stderr.write = writeErr;
  }
};

describe("ledgerRecords", () => {
  test("stamps each row with the service whose file it came from", () => {
    const files = ledgerDir({
      gateway: [{ event: "atm.request", route: "tasks" }],
      loop: [runRow({ outcome: "done" })],
    });
    expect(ledgerRecords(files)).toEqual([
      { event: "atm.request", route: "tasks", service: "gateway" },
      { event: "atm.run", outcome: "done", phase: "end", service: "loop" },
    ]);
  });

  test("skips blank lines, half-written rows and anything not a marker", () => {
    const dir = mkdtempSync(join(tmpdir(), "logs-sql-"));
    const path = join(dir, "loop.jsonl");
    writeFileSync(
      path,
      [
        JSON.stringify(runRow({ outcome: "done" })),
        "",
        '{"event":"atm.run","phase":',
        JSON.stringify({ event: "other.thing" }),
        JSON.stringify({ level: "info", msg: "not an event" }),
      ].join("\n")
    );
    expect(ledgerRecords([path])).toHaveLength(1);
  });
});

describe("columnsOf", () => {
  test("unions the keys, service and ts first and the rest sorted", () => {
    expect(
      columnsOf([
        { costUsd: 1, event: "atm.run", service: "loop" },
        { event: "atm.run", repo: "a/b", ts: "2026-01-01" },
      ])
    ).toEqual(["service", "ts", "event", "costUsd", "repo"]);
  });

  test("a key on one row in a thousand is still a column", () => {
    const rows = [
      ...Array.from({ length: 999 }, () => ({ event: "atm.run" })),
      { event: "atm.run", quotaProvider: "claude" },
    ];
    expect(columnsOf(rows)).toContain("quotaProvider");
  });
});

describe("loadTable", () => {
  test("keeps the storage class the JSON had", () => {
    const db = new Database(":memory:");
    loadTable(db, "t", [{ costUsd: 0.25, totalTokens: 1234 }]);
    expect(
      db.prepare("select typeof(totalTokens) as tokens, costUsd from t").all()
    ).toEqual([{ costUsd: 0.25, tokens: "integer" }]);
  });

  test("a nested value lands as JSON that json_extract reads", () => {
    const db = new Database(":memory:");
    loadTable(db, "t", [{ changes: { status: { to: "done" } } }]);
    expect(
      db
        .prepare("select json_extract(changes, '$.status.to') as v from t")
        .all()
    ).toEqual([{ v: "done" }]);
  });

  test("an empty table still has the shape it was given", () => {
    const db = new Database(":memory:");
    loadTable(db, "t", [], { fallbackColumns: ["a", "b"] });
    expect(db.prepare("select a, b from t").all()).toEqual([]);
  });
});

describe("pgTablesIn", () => {
  test("names a table the query joins", () => {
    expect(
      pgTablesIn(
        "select * from events e join audit_entry a on a.trace_id = e.traceId"
      )
    ).toEqual(["audit_entry"]);
  });

  test("the marker 'atm.run' does not ask for the run table", () => {
    expect(pgTablesIn("select * from events where event = 'atm.run'")).toEqual(
      []
    );
  });

  test("a column named runId does not ask for the run table", () => {
    expect(pgTablesIn("select runId, taskId from events")).toEqual([]);
  });

  test("finds the table on its own", () => {
    expect(pgTablesIn("select count(*) from run")).toEqual(["run"]);
    expect(pgTablesIn("SELECT * FROM Task")).toEqual(["task"]);
  });
});

describe("renderTable", () => {
  test("right-aligns a numeric column and prints null as a dash", () => {
    const rendered = renderTable(
      ["repo", "costUsd"],
      [
        { costUsd: 1.5, repo: "a/b" },
        { costUsd: null, repo: "cc/dd" },
      ]
    );
    expect(rendered.split("\n")).toEqual([
      "repo  costUsd",
      "a/b       1.5",
      "cc/dd       -",
    ]);
  });

  test("a long cell is cut and says so", () => {
    const rendered = renderTable(["m"], [{ m: "x".repeat(100) }]);
    expect(rendered.split("\n")[1]).toEndWith("…");
    expect(rendered.split("\n")[1]?.length).toBe(48);
  });
});

describe("runSqlView", () => {
  test("queries the union of every ledger file", async () => {
    const files = ledgerDir({
      gateway: [{ event: "atm.request", route: "tasks" }],
      loop: [runRow({ costUsd: 1, outcome: "done" })],
    });
    const { code, out } = await query(
      files,
      "select service, event from events order by service"
    );
    expect(code).toBe(0);
    expect(out.split("\n").slice(0, 3)).toEqual([
      "service event",
      "gateway atm.request",
      "loop    atm.run",
    ]);
  });

  test("finds the run that was claimed and never closed", async () => {
    const files = ledgerDir({
      loop: [
        { event: "atm.run", phase: "start", runId: "a" },
        runRow({ outcome: "done", runId: "a" }),
        { event: "atm.run", phase: "start", runId: "b" },
      ],
    });
    const { out } = await query(
      files,
      `select s.runId from events s where s.phase = 'start'
       and not exists (select 1 from events e
         where e.runId = s.runId and e.phase = 'end')`
    );
    expect(out.split("\n").slice(0, 2)).toEqual(["runId", "b"]);
  });

  test("an empty result prints the columns that were asked for", async () => {
    const files = ledgerDir({
      loop: [runRow({ costUsd: 1, outcome: "done" })],
    });
    const { code, out } = await query(
      files,
      "select outcome, costUsd from events where outcome = 'errored'"
    );
    expect(code).toBe(0);
    expect(out).toBe("outcome costUsd\n");
  });

  test("a missing ledger directory is an empty table, not a crash", async () => {
    const { code, out } = await query([], "select count(*) as n from events");
    expect(code).toBe(0);
    expect(out).toBe("n\n0\n");
  });

  test("no query prints the schema and the examples", async () => {
    const files = ledgerDir({
      loop: [runRow({ outcome: "done", repo: "a/b" })],
    });
    const { code, out } = await query(files, undefined);
    expect(code).toBe(0);
    expect(out).toContain(`${EVENTS_TABLE} (`);
    expect(out).toContain("  repo");
    expect(out).toContain("audit_entry");
  });

  test("a query SQLite refuses fails the command and says why", async () => {
    const files = ledgerDir({ loop: [runRow({ outcome: "done" })] });
    const { code, err, out } = await query(files, "select nope from events");
    expect(code).toBe(1);
    expect(out).toBe("");
    expect(err).toContain("no such column: nope");
  });

  test("a second statement is dropped, and the drop is said out loud", async () => {
    const files = ledgerDir({ loop: [runRow({ outcome: "done" })] });
    const { err } = await query(
      files,
      "select 1 as a from events; select 2 as b from events;"
    );
    expect(err).toContain("only the first statement is run");
  });

  test("naming a database table with no DATABASE_URL fails with the reason", async () => {
    const previous = process.env.DATABASE_URL;
    process.env.DATABASE_URL = "";
    try {
      const { code, err } = await query(
        ledgerDir({ loop: [runRow({ outcome: "done" })] }),
        "select count(*) from run"
      );
      expect(code).toBe(1);
      expect(err).toContain("DATABASE_URL is not set");
    } finally {
      if (previous === undefined) {
        process.env.DATABASE_URL = undefined;
      } else {
        process.env.DATABASE_URL = previous;
      }
    }
  });
});
