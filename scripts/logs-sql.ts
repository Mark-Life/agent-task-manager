/**
 * The `sql` view of the ledger: one SQLite table over every wide event on disk,
 * and the database tables the events already join to.
 *
 * The fixed views answer the questions someone knew to ask when they were
 * written. This one is for the rest, and for the join in particular: a run's
 * `traceId` is on its `atm.run` row and on `run.trace_id` and `audit_entry.
 * trace_id`, so "what did this run change, and who else touched that task" is a
 * query nobody could write because the two halves lived in different stores.
 * They meet here, in a scratch SQLite database built fresh on every invocation.
 *
 * The events table's columns are the union of the keys the ledger actually
 * holds rather than a list written down here, so a field added to a wide event
 * is queryable the next time it is written, without touching this file. A
 * marker's own fields are null on every row from another marker; that is what a
 * union of markers in one table means, and `where event = '...'` is how you
 * stop seeing it.
 *
 * The user's SQL only ever reaches the local copy. What goes to Postgres is
 * `select * from <table>` for a table named in {@link PG_TABLES}, chosen by
 * matching the query text against that list — never text taken from the query.
 * A read-only credential is still the right one to hold, but a `delete` typed
 * here deletes rows from a scratch file that is gone when the process exits.
 */

import { Database } from "bun:sqlite";
import { readFileSync } from "node:fs";
import { basename } from "node:path";

/** Every row the ledger writes carries this prefix on its `event` field. */
const EVENT_PREFIX = "atm.";

/** The one table built from the files on disk. */
export const EVENTS_TABLE = "events";

/**
 * Names the ledger file a row came from. The row itself does not carry it —
 * the file is the fact — so the loader adds it and wins any collision.
 */
const SERVICE_COLUMN = "service";

/**
 * What a reader wants at the left edge of `select *`. Everything else follows
 * alphabetically, which is arbitrary but at least stable between runs, and is
 * also the header a `sql` with no query prints as the schema.
 */
const LEAD_COLUMNS = [
  SERVICE_COLUMN,
  "ts",
  "event",
  "phase",
  "outcome",
] as const;

/**
 * Database tables the viewer will copy in, loaded only when the query names
 * one. Each joins the ledger by a column the writer already populates:
 * `run.trace_id` and `audit_entry.trace_id` against an event's `traceId`,
 * `task.id` against its `taskId`.
 *
 * `run_event` is deliberately absent: it is the container's whole event stream,
 * hundreds of rows per run, and copying it whole to answer a question about one
 * run would cost more than the question is worth.
 */
export const PG_TABLES = ["audit_entry", "run", "task"] as const;

/** A table this viewer will copy out of Postgres. */
export type PgTable = (typeof PG_TABLES)[number];

/** One parsed ledger line, before it becomes a row. */
type Record_ = Readonly<Record<string, unknown>>;

/**
 * Quotes an identifier for SQLite. Applied to every column name, because the
 * ledger's vocabulary is not this file's to vet — a field named `order` is a
 * syntax error unquoted and a column like any other quoted.
 */
const quote = (identifier: string) => `"${identifier.replaceAll('"', '""')}"`;

/**
 * The union of every key across `records`, lead columns first and the rest
 * sorted. A key that appears on one row in ten thousand still becomes a column:
 * a rare field is usually the interesting one.
 */
export const columnsOf = (records: readonly Record_[]) => {
  const seen = new Set<string>();
  for (const record of records) {
    for (const key of Object.keys(record)) {
      seen.add(key);
    }
  }
  const lead: string[] = LEAD_COLUMNS.filter((column) => seen.has(column));
  const rest = [...seen]
    .filter((column) => !lead.includes(column))
    .sort((left, right) => left.localeCompare(right));
  return [...lead, ...rest];
};

/**
 * A JSON value as SQLite can store it. Numbers and strings pass through, so
 * `costUsd > 0.5` compares numbers and `durationMs` prints as the integer it
 * was; a nested object becomes JSON text, which `json_extract` reads.
 */
const sqliteValue = (value: unknown) => {
  if (value === null || value === undefined) {
    return null;
  }
  if (typeof value === "number" || typeof value === "string") {
    return value;
  }
  if (typeof value === "boolean") {
    return value ? 1 : 0;
  }
  if (value instanceof Date) {
    return value.toISOString();
  }
  return JSON.stringify(value);
};

/** What a table needs when the rows themselves name no columns. */
interface LoadOptions {
  /** Column names to use when `records` is empty, so the table still exists. */
  readonly fallbackColumns?: readonly string[];
}

/**
 * Creates `table` and fills it. Columns are declared with no type: a declared
 * affinity would rewrite what the ledger stored — `1234` arriving as `1234.0`
 * under REAL — and the storage class SQLite infers from the bound value is
 * already the one the JSON had.
 */
export const loadTable = (
  db: Database,
  table: string,
  records: readonly Record_[],
  options: LoadOptions = {}
) => {
  const columns =
    records.length === 0
      ? [...(options.fallbackColumns ?? [])]
      : columnsOf(records);
  if (columns.length === 0) {
    // SQLite has no zero-column table. Nothing was written and nothing was
    // declared, so there is no shape to offer; the placeholder keeps a query
    // against the table an empty result rather than "no such table".
    columns.push("empty");
  }
  db.run(`create table ${quote(table)} (${columns.map(quote).join(", ")})`);
  if (records.length === 0) {
    return columns;
  }
  const insert = db.prepare(
    `insert into ${quote(table)} values (${columns.map(() => "?").join(", ")})`
  );
  // One transaction: ten thousand autocommitted inserts is the difference
  // between a viewer that starts instantly and one nobody uses twice.
  db.transaction((rows: readonly Record_[]) => {
    for (const row of rows) {
      insert.run(...columns.map((column) => sqliteValue(row[column])));
    }
  })(records);
  return columns;
};

/**
 * Reads every `atm.*` row out of the ledger files, stamped with the service
 * whose file it came from. A malformed line is skipped rather than fatal: the
 * last line of a file being written to is routinely half a row.
 */
export const ledgerRecords = (files: readonly string[]) => {
  const records: Record_[] = [];
  for (const file of files) {
    const service = basename(file, ".jsonl");
    for (const line of readFileSync(file, "utf8").split("\n")) {
      const trimmed = line.trim();
      if (trimmed.length === 0) {
        continue;
      }
      try {
        const parsed = JSON.parse(trimmed);
        if (
          typeof parsed?.event === "string" &&
          parsed.event.startsWith(EVENT_PREFIX)
        ) {
          records.push({ ...parsed, [SERVICE_COLUMN]: service });
        }
      } catch {
        // Not a row. Half-written lines and stray output both land here.
      }
    }
  }
  return records;
};

/**
 * Which database tables a query names.
 *
 * A leading `.` or word character disqualifies the match, which is what keeps
 * the marker `'atm.run'` — a string literal in half the queries anyone will
 * write — from opening a database connection to satisfy a table nobody asked
 * for. The cost of the remaining false positive, a query mentioning `task` in
 * a comment, is one `select` this process then does not use.
 */
export const pgTablesIn = (query: string): PgTable[] =>
  PG_TABLES.filter((table) =>
    new RegExp(String.raw`(?<![\w.])${table}\b`, "i").test(query)
  );

/**
 * Copies the named tables in. `pg` is imported here rather than at the top of
 * the file so the ledger-only views keep the property the rest of this command
 * has: no dependency to install, no service to reach, no database to be up.
 */
const loadPgTables = async (db: Database, tables: readonly PgTable[]) => {
  if (tables.length === 0) {
    return;
  }
  const url = process.env.DATABASE_URL?.trim();
  if (!url) {
    throw new Error(
      `the query names ${tables.join(", ")}, which ${
        tables.length === 1 ? "is a database table" : "are database tables"
      }, and DATABASE_URL is not set`
    );
  }
  const { Client } = await import("pg");
  const client = new Client({ connectionString: url });
  await client.connect();
  try {
    // Issued together and answered in order: one connection serializes them on
    // the wire anyway, and a query naming two tables should cost one round of
    // waiting rather than two.
    const results = await Promise.all(
      // The identifier is one of `PG_TABLES`, never a substring of the query.
      tables.map((table) => client.query(`select * from ${quote(table)}`))
    );
    for (const [index, table] of tables.entries()) {
      const result = results[index];
      loadTable(db, table, result?.rows ?? [], {
        // Postgres describes the columns even when it returns no rows, so an
        // empty table still arrives with its real shape.
        fallbackColumns: result?.fields.map((field) => field.name),
      });
    }
  } finally {
    await client.end();
  }
};

/** Longest a cell is printed before it is cut; `--json` is the way to see it whole. */
const CELL_MAX = 48;

/** How a value prints in the aligned table. Null is `-`, as in every other view. */
const cell = (value: unknown) => {
  if (value === null || value === undefined) {
    return "-";
  }
  const text =
    typeof value === "object" ? JSON.stringify(value) : String(value);
  return text.length > CELL_MAX ? `${text.slice(0, CELL_MAX - 1)}…` : text;
};

/**
 * Renders a result set as an aligned table. Numeric columns are right-aligned,
 * decided per column over the values that are actually there, so a column of
 * costs lines up on the decimal point and a column of ids does not.
 */
export const renderTable = (
  columns: readonly string[],
  rows: readonly Record_[]
) => {
  const numeric = columns.map((column) =>
    rows.some((row) => typeof row[column] === "number")
  );
  const widths = columns.map((column) =>
    Math.max(column.length, ...rows.map((row) => cell(row[column]).length))
  );
  const line = (values: readonly string[]) =>
    values
      .map((value, index) =>
        numeric[index]
          ? value.padStart(widths[index] ?? 0)
          : value.padEnd(widths[index] ?? 0)
      )
      .join(" ")
      .trimEnd();
  return [
    line(columns),
    ...rows.map((row) => line(columns.map((column) => cell(row[column])))),
  ].join("\n");
};

/**
 * A statement separator with anything after it. SQLite prepares one statement
 * and drops the rest without complaining, so a pasted pair of queries would
 * silently answer the first — this is what turns that into a line on stderr.
 * A `;` inside a string literal trips it too, which costs a spurious note and
 * no result.
 */
const TRAILING_STATEMENT = /;\s*\S/;

/** Example queries, printed as the help and meant to be copied and edited. */
const EXAMPLES = [
  "-- the last ten runs that did not finish clean",
  "select ts, outcome, errorClass, repo from events",
  "where event = 'atm.run' and phase = 'end' and outcome <> 'done'",
  "order by ts desc limit 10;",
  "",
  "-- runs claimed and never closed: the pair the two-row shape exists to find",
  "select ts, runId, repo from events s where s.phase = 'start'",
  "and not exists (select 1 from events e",
  "  where e.runId = s.runId and e.phase = 'end');",
  "",
  "-- what a run changed, over the trace id both stores already carry",
  "select e.ts, a.action, a.entity_type, a.from_status, a.to_status",
  "from events e join audit_entry a on a.trace_id = e.traceId",
  "where e.event = 'atm.run' and e.phase = 'end' order by e.ts;",
  "",
  "-- terminuses in the ledger against rows in the database",
  "select (select count(*) from events",
  "  where event = 'atm.run' and phase = 'end') as ledger,",
  "  (select count(*) from run where outcome is not null) as db;",
];

/** Prints the tables, their columns, and the examples. */
const printSchema = (columns: readonly string[]) => {
  const out = [
    `${EVENTS_TABLE} (${columns.length} columns, every atm.* row on disk)`,
    ...columns.map((column) => `  ${column}`),
    "",
    "copied from Postgres when the query names one:",
    ...PG_TABLES.map((table) => `  ${table}`),
    "",
    ...EXAMPLES,
    "",
  ].join("\n");
  process.stdout.write(`${out}\n`);
};

/** What the `sql` view needs from the command that dispatches to it. */
export interface SqlViewOptions {
  /** Ledger files to load, in the order their rows should be inserted. */
  readonly files: readonly string[];
  /** Print one JSON object per row instead of an aligned table. */
  readonly json: boolean;
  /** The query. Absent prints the schema and the examples instead. */
  readonly query: string | undefined;
}

/**
 * Builds the scratch database, runs one query against it, and prints the
 * result. Returns the process exit code: a query SQLite refuses is a failed
 * command, so `&&` in a shell means what it looks like.
 */
export const runSqlView = async (options: SqlViewOptions) => {
  const db = new Database(":memory:");
  const columns = loadTable(db, EVENTS_TABLE, ledgerRecords(options.files), {
    fallbackColumns: LEAD_COLUMNS,
  });
  const query = options.query?.trim();
  if (!query) {
    printSchema(columns);
    return 0;
  }
  if (TRAILING_STATEMENT.test(query)) {
    process.stderr.write("only the first statement is run\n");
  }
  try {
    await loadPgTables(db, pgTablesIn(query));
    const statement = db.prepare(query);
    const rows = statement.all() as Record_[];
    if (options.json) {
      for (const row of rows) {
        process.stdout.write(`${JSON.stringify(row)}\n`);
      }
      return 0;
    }
    // The statement names its result columns even when it matched nothing, and
    // in the order they were selected, so an empty result still prints the
    // shape of the answer and a wide one is not silently re-sorted.
    process.stdout.write(`${renderTable(statement.columnNames, rows)}\n`);
    return 0;
  } catch (cause) {
    process.stderr.write(`${(cause as Error).message}\n`);
    return 1;
  } finally {
    db.close();
  }
};
