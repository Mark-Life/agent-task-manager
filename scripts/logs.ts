#!/usr/bin/env bun

/**
 * Wide-event ledger viewer: `runs | errors | stats | follow | sql` over the
 * JSONL files under EVENT_LOG_DIR (default `${DATA_ROOT}/events`), one file per
 * service (`loop.jsonl`, `gateway.jsonl`, ...). Within a file the `event` field
 * names the unit of work, so one service may write several markers; the fixed
 * views take a marker so counts stay about one kind of thing. Reads the ledger
 * directly; never talks to a running service.
 *
 * `sql` is the view for the questions the fixed four do not answer: it loads
 * every row into a scratch SQLite database, alongside the database tables the
 * events join to, and runs the query you give it. It takes a query rather than
 * a marker.
 *
 * `atm.request` is thinned before it is stored, so `stats` prints what is on
 * disk and, beside it, what those rows stand for once each is multiplied by the
 * `sampleRate` it carries.
 *
 * Usage: `bun run logs [runs|errors|stats|follow] [marker|all]`
 *        `bun run logs sql ["<query>"] [--json]`
 */

import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { open, stat } from "node:fs/promises";
import { join } from "node:path";
import { runSqlView } from "./logs-sql";

/**
 * Reads an environment variable, treating blank as unset. `.env` files routinely
 * carry a documented-but-empty key, and Effect's `Config` already skips those —
 * matching it here keeps the viewer pointed at the directory the sink writes to.
 */
const envOr = (name: string, fallback: string) =>
  process.env[name]?.trim() || fallback;

const DATA_ROOT = envOr("DATA_ROOT", ".data");
const EVENT_LOG_DIR = envOr("EVENT_LOG_DIR", join(DATA_ROOT, "events"));
const EVENT_PREFIX = "atm.";
/** Marker the views read when none is named: the canonical record of the system. */
const DEFAULT_MARKER = "atm.run";
/** Marker argument that turns marker filtering off. */
const ALL_MARKERS = "all";
const POLL_MS = 500;

/** Outcome given to a start row whose unit never wrote a terminus. */
const LOST = "lost";

/** Width-1 ASCII markers per outcome (emoji render double-width and break table alignment). */
const MARK: Record<string, string> = {
  already_running: "-",
  at_capacity: "!",
  done: "+",
  errored: "x",
  interrupted: "~",
  lost: "?",
  parked: "=",
  stopped: "s",
  timeout: "#",
};

/** One parsed wide event. Fields are best-effort — any may be absent. */
interface EventRow {
  costUsd?: number | null;
  durationMs?: number | null;
  errorClass?: string;
  errorMessage?: string;
  event?: string;
  outcome?: string | null;
  phase?: string;
  projectId?: string | null;
  provider?: string;
  repo?: string | null;
  runId?: string | null;
  sampleRate?: number | null;
  totalTokens?: number | null;
  ts?: string;
  turns?: number | null;
}

/** Parse one JSONL line, returning the row only when it carries an `atm.*` marker. */
const parseLine = (line: string, marker: string) => {
  const trimmed = line.trim();
  if (!trimmed) {
    return null;
  }
  try {
    const parsed = JSON.parse(trimmed);
    if (typeof parsed?.event !== "string") {
      return null;
    }
    const wanted =
      marker === ALL_MARKERS
        ? parsed.event.startsWith(EVENT_PREFIX)
        : parsed.event === marker;
    return wanted ? (parsed as EventRow) : null;
  } catch {
    return null;
  }
};

/** List `*.jsonl` files in the event log directory, empty when the directory is missing. */
const listLedgerFiles = (dir: string) => {
  if (!existsSync(dir)) {
    return [];
  }
  return readdirSync(dir)
    .filter((name) => name.endsWith(".jsonl"))
    .map((name) => join(dir, name))
    .sort();
};

/**
 * Collapses the two rows a long unit of work writes into the one thing that
 * happened. A start row whose `runId` also has a terminus is dropped — the
 * terminus carries the whole story, and counting both doubles every total. A
 * start row with no terminus is the interesting case: the unit was claimed and
 * never closed, so it is reported as `lost` rather than vanishing.
 */
const reconcilePhases = (rows: EventRow[]) => {
  const terminated = new Set(
    rows
      .filter((row) => row.phase !== "start" && row.runId)
      .map((row) => row.runId)
  );
  return rows.flatMap((row) => {
    if (row.phase !== "start") {
      return [row];
    }
    return row.runId && terminated.has(row.runId)
      ? []
      : [{ ...row, outcome: LOST }];
  });
};

/** Read and parse every event row across every ledger file, sorted by timestamp. */
const readAllRows = (dir: string, marker: string) => {
  const rows: EventRow[] = [];
  for (const file of listLedgerFiles(dir)) {
    const text = readFileSync(file, "utf8");
    for (const line of text.split("\n")) {
      const row = parseLine(line, marker);
      if (row) {
        rows.push(row);
      }
    }
  }
  return reconcilePhases(rows).sort((a, b) =>
    (a.ts ?? "").localeCompare(b.ts ?? "")
  );
};

/** Pad `s` to width `w`, right-aligned when `right`, truncating overflow. */
const pad = (s: string, w: number, right = false) => {
  const v = s.length > w ? s.slice(0, w) : s;
  return right ? v.padStart(w) : v.padEnd(w);
};

const TIME_W = 8;
const MARK_W = 1;
const COST_W = 9;
const DUR_W = 8;
const TURNS_W = 5;
const TOK_W = 9;
const PROJECT_W = 16;
const CLASS_W = 18;
const COST_DECIMALS = 4;
const DUR_DECIMALS = 1;
const MS_PER_SEC = 1000;

/** HH:MM:SS from an ISO timestamp; falls back to a placeholder when unparseable. */
const fmtTime = (ts?: string) => {
  if (!ts) {
    return "--:--:--";
  }
  const d = new Date(ts);
  return Number.isNaN(d.getTime())
    ? pad(ts, TIME_W)
    : d.toTimeString().slice(0, TIME_W);
};

/** `$x.xxxx` or `-` when the row reported no cost (interrupt/timeout/degraded). */
const fmtCost = (n?: number | null) =>
  typeof n === "number" ? `$${n.toFixed(COST_DECIMALS)}` : "-";

/** Human duration (`1.2s` / `340ms`) or `-`. */
const fmtDur = (ms?: number | null) => {
  if (typeof ms !== "number") {
    return "-";
  }
  return ms >= MS_PER_SEC
    ? `${(ms / MS_PER_SEC).toFixed(DUR_DECIMALS)}s`
    : `${ms}ms`;
};

/** Integer or `-`. */
const fmtInt = (n?: number | null) =>
  typeof n === "number" ? n.toLocaleString() : "-";

/**
 * What the row was working on. `atm.run` carries both `repo` (`owner/name`,
 * parsed out of the URL) and `projectId` (a uuid), and the repository is the
 * one a reader recognizes, so it wins and the id is the fallback for a project
 * with no repository set. Markers that name neither get `-`.
 */
const fmtProject = (r: EventRow) => r.repo ?? r.projectId ?? "-";

/** One aligned `runs` / `follow` row. */
const runLine = (r: EventRow) => {
  const mark = MARK[r.outcome ?? ""] ?? "?";
  return [
    pad(fmtTime(r.ts), TIME_W),
    pad(mark, MARK_W),
    pad(fmtCost(r.costUsd), COST_W, true),
    pad(fmtDur(r.durationMs), DUR_W, true),
    pad(fmtInt(r.turns), TURNS_W, true),
    pad(fmtInt(r.totalTokens), TOK_W, true),
    fmtProject(r),
  ].join(" ");
};

const RUN_HEADER = [
  pad("TIME", TIME_W),
  pad("O", MARK_W),
  pad("COST", COST_W, true),
  pad("DUR", DUR_W, true),
  pad("TURNS", TURNS_W, true),
  pad("TOKENS", TOK_W, true),
  "PROJECT",
].join(" ");

/** One aligned `errors` row: time, marker, project, errorClass, errorMessage. */
const errorLine = (r: EventRow) =>
  [
    pad(fmtTime(r.ts), TIME_W),
    pad(MARK[r.outcome ?? ""] ?? "?", MARK_W),
    pad(fmtProject(r), PROJECT_W),
    pad(r.errorClass ?? "-", CLASS_W),
    r.errorMessage ?? "-",
  ].join(" ");

const ERR_HEADER = [
  pad("TIME", TIME_W),
  pad("O", MARK_W),
  pad("PROJECT", PROJECT_W),
  pad("CLASS", CLASS_W),
  "MESSAGE",
].join(" ");

/**
 * How many units of work one stored row stands for.
 *
 * The gateway thins its own marker and stamps every row it keeps with the
 * number of requests that row represents, so a count over `atm.request` is a
 * count of the sample until it is multiplied by this. Every other marker stores
 * every row and so weighs one, which is also what a row that names no weight
 * gets: a row that cannot say what it stands for still happened once.
 */
const weightOf = (row: EventRow) =>
  typeof row.sampleRate === "number" && row.sampleRate >= 1
    ? row.sampleRate
    : 1;

/**
 * The estimate beside a stored count, shown only where the two differ — on an
 * unsampled marker the parenthesis would be the same number twice.
 */
const fmtEstimate = (stored: number, estimated: number) =>
  estimated === stored ? "" : `  (~${Math.round(estimated)} before sampling)`;

/** Print aggregate counts, total cost, and total wall time across all rows. */
const printStats = (rows: EventRow[], marker: string) => {
  const counts: Record<string, number> = {};
  const estimates: Record<string, number> = {};
  let storedRows = 0;
  let estimatedRows = 0;
  let totalCost = 0;
  let totalMs = 0;
  for (const r of rows) {
    const outcome = r.outcome ?? "unknown";
    const weight = weightOf(r);
    counts[outcome] = (counts[outcome] ?? 0) + 1;
    estimates[outcome] = (estimates[outcome] ?? 0) + weight;
    storedRows += 1;
    estimatedRows += weight;
    if (typeof r.costUsd === "number") {
      totalCost += r.costUsd * weight;
    }
    if (typeof r.durationMs === "number") {
      totalMs += r.durationMs * weight;
    }
  }
  // The count is labelled with what was counted: totals mean nothing until you
  // know whether they are over runs, agent turns, or everything at once — and,
  // where the marker is sampled, whether they are over the rows on disk or over
  // the traffic those rows stand for. Both are printed rather than one.
  process.stdout.write(
    `${pad(marker, PROJECT_W)} ${storedRows}${fmtEstimate(storedRows, estimatedRows)}\n`
  );
  for (const [outcome, n] of Object.entries(counts).sort()) {
    const mark = MARK[outcome] ?? "?";
    const estimated = estimates[outcome] ?? n;
    process.stdout.write(
      `  ${mark} ${pad(outcome, PROJECT_W)} ${n}${fmtEstimate(n, estimated)}\n`
    );
  }
  process.stdout.write(`total cost  $${totalCost.toFixed(COST_DECIMALS)}\n`);
  process.stdout.write(
    `total wall  ${(totalMs / MS_PER_SEC).toFixed(DUR_DECIMALS)}s\n`
  );
};

/** Per-file poll-tail state: byte offset already drained. */
interface TailState {
  offset: number;
}

/** Read newly appended bytes from `file` past `state.offset` and print any complete rows. */
const drainFile = async (file: string, state: TailState, marker: string) => {
  let size: number;
  try {
    ({ size } = await stat(file));
  } catch {
    return;
  }
  if (size < state.offset) {
    state.offset = 0; // file truncated or rotated
  }
  if (size <= state.offset) {
    return;
  }
  const fh = await open(file, "r");
  try {
    const buf = Buffer.alloc(size - state.offset);
    await fh.read(buf, 0, buf.length, state.offset);
    const text = buf.toString("utf8");
    const lastNl = text.lastIndexOf("\n");
    const consumable = lastNl === -1 ? "" : text.slice(0, lastNl);
    for (const line of consumable.split("\n")) {
      const row = parseLine(line, marker);
      if (row) {
        process.stdout.write(`${runLine(row)}\n`);
      }
    }
    state.offset += Buffer.byteLength(
      lastNl === -1 ? "" : `${consumable}\n`,
      "utf8"
    );
  } finally {
    await fh.close();
  }
};

/** Poll-tail every ledger file, printing newly appended rows and picking up files created later. */
const runFollow = async (dir: string, marker: string) => {
  const states = new Map<string, TailState>();

  const tick = async () => {
    const files = listLedgerFiles(dir).map((file) => {
      let state = states.get(file);
      if (!state) {
        // New files start at the end — `follow` shows what happens next, not history.
        const startOffset = existsSync(file) ? statSync(file).size : 0;
        state = { offset: startOffset };
        states.set(file, state);
      }
      return { file, state };
    });
    await Promise.all(
      files.map(({ file, state }) => drainFile(file, state, marker))
    );
  };

  await tick();
  setInterval(() => {
    tick().catch(() => {
      // transient read error — keep polling
    });
  }, POLL_MS);
};

process.stdout.on("error", (e) => {
  if ((e as NodeJS.ErrnoException).code === "EPIPE") {
    process.exit(0);
  }
});

/** Prints one JSON object per row instead of an aligned table. `sql` only. */
const JSON_FLAG = "--json";

/** Standard input, read as a file so the whole pipe arrives before the query runs. */
const STDIN_FD = 0;

// Only the exact flag is removed, not every argument that starts with `-`: a
// SQL query may legitimately open with a `--` comment line.
const json = process.argv.includes(JSON_FLAG);
const args = process.argv.slice(2).filter((arg) => arg !== JSON_FLAG);
const mode = args[0] ?? "runs";
const requestedMarker = args[1] ?? DEFAULT_MARKER;

if (mode === "sql") {
  // A query long enough to be worth writing is long enough to want a heredoc or
  // a file, so a piped stdin is read as the query when the argument is absent.
  const piped =
    args[1] === undefined && !process.stdin.isTTY
      ? readFileSync(STDIN_FD, "utf8")
      : undefined;
  process.exitCode = await runSqlView({
    files: listLedgerFiles(EVENT_LOG_DIR),
    json,
    query: args[1] ?? piped,
  });
} else if (mode === "follow") {
  await runFollow(EVENT_LOG_DIR, requestedMarker);
} else {
  const rows = readAllRows(EVENT_LOG_DIR, requestedMarker);
  if (mode === "errors") {
    process.stdout.write(`${ERR_HEADER}\n`);
    // Every non-success ending, not just `errored`: a timeout, an interrupt and
    // a lost unit all carry a class and a message, and all of them are why
    // someone opened this view.
    for (const r of rows) {
      if (r.outcome !== "done") {
        process.stdout.write(`${errorLine(r)}\n`);
      }
    }
  } else if (mode === "stats") {
    printStats(rows, requestedMarker);
  } else {
    process.stdout.write(`${RUN_HEADER}\n`);
    for (const r of rows) {
      process.stdout.write(`${runLine(r)}\n`);
    }
  }
}
