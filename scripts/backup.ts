#!/usr/bin/env bun

/**
 * The database and the artifact tree, copied off the volume they live on.
 *
 * Everything the board knows is in one Postgres volume — `atm_postgres_data` in
 * `docker-compose.yml` — and every file a run kept is in one directory under
 * `DATA_ROOT`. Neither had a second copy. `docker volume rm` in the wrong
 * terminal, or the disk this VPS rents, ends the project. This is the answer to
 * that and nothing more: a dump, a tar, a retention window, and a restore you
 * can actually run.
 *
 *     bun run backup           # dump, tar, prune, write a manifest
 *     bun run backup:list      # what is on disk and how old it is
 *     bun run backup:verify    # restore the newest dump into a scratch database
 *
 * **A dump is not a backup until it has been restored.** `pg_restore --list`
 * reads the archive's table of contents and proves the header is not truncated;
 * it does not prove a single row survived, and this file never says otherwise.
 * `take` runs it and calls it a readability check. `verify` is the real thing:
 * it creates a scratch database, restores into it, counts every table and
 * compares those counts against the manifest written at dump time. That is the
 * command to run after any change here, and the one the schedule cannot run for
 * you because it needs a database to write to.
 *
 * **Two ways to reach Postgres, and the container one is preferred.** A
 * `pg_dump` older than the server refuses to run — that is the single commonest
 * way a backup schedule turns out to have been failing for months — so the
 * first choice is `docker compose exec postgres pg_dump`, where the client is
 * the server's own binary and cannot be the wrong version. A host `pg_dump` is
 * the fallback, for a host with no Compose or a database somewhere else, and it
 * is checked against the server's major version before anything is written.
 *
 * **No credential ever reaches argv.** `ps` is world-readable. Connection
 * settings go to the child as `PGHOST`/`PGUSER`/`PGPASSWORD` and friends, and
 * the container path needs no password at all because it connects over the unix
 * socket inside the container, which the official image trusts.
 *
 * **The output is a secret.** The dump carries Better Auth password hashes and
 * the encrypted project environment; `globals.sql` carries role passwords. The
 * backup root is `0700` and every file in it is `0600`. It sits beside
 * `DATA_ROOT` rather than inside it, so the `rm -rf` that takes the data root
 * does not take its own backups with it.
 */

import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  chmodSync,
  closeSync,
  existsSync,
  linkSync,
  mkdirSync,
  openSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { basename, join, resolve } from "node:path";

/** The repository root, from this file rather than from the caller's cwd. */
const REPO_DIR = resolve(import.meta.dir, "..");

/** How many day-stamped sets survive a prune. */
const DEFAULT_KEEP_DAILY = 14;

/** How many week-stamped sets survive a prune, on top of the daily ones. */
const DEFAULT_KEEP_WEEKLY = 4;

/** Mode for the backup root. Nobody but the operator reads a dump. */
const DIR_MODE = 0o700;

/** Mode for every file written under it, for the same reason. */
const FILE_MODE = 0o600;

/** Indent for `--json` output and the manifest, so both are readable. */
const JSON_INDENT = 2;

/** Step between the units {@link humanBytes} prints. */
const BYTES_PER_UNIT = 1024;

/** Tenths, for the one decimal place a duration is reported to. */
const TENTHS = 10;

/** Milliseconds per tenth of a second, for the same. */
const MS_PER_TENTH = 100;

/**
 * The cap on what a captured child may write to a pipe. Node defaults to 1 MB
 * and truncates past it; the largest thing captured here is a `pg_restore
 * --list`, and everything that could really grow goes to a file instead.
 */
const MAX_CAPTURED_MEGABYTES = 256;
const MAX_CAPTURED_BYTES =
  MAX_CAPTURED_MEGABYTES * BYTES_PER_UNIT * BYTES_PER_UNIT;

/** The Compose service holding Postgres, as `docker-compose.yml` names it. */
const COMPOSE_SERVICE = "postgres";

/** What each file in a backup set is called. */
const DUMP_FILE = "db.dump";
const GLOBALS_FILE = "globals.sql";
const ARTIFACTS_FILE = "artifacts.tar.gz";
const MANIFEST_FILE = "manifest.json";

/** Everything a set holds, which is what a weekly anchor hardlinks. */
const SET_FILES = [DUMP_FILE, GLOBALS_FILE, ARTIFACTS_FILE, MANIFEST_FILE];

/** `YYYY-MM-DD`, the name of a daily set. */
const DAY_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

/** `YYYY-Www`, the name of a weekly set. */
const WEEK_PATTERN = /^\d{4}-W\d{2}$/;

/** ISO 8601 week arithmetic: Monday is 1, and week 1 holds the first Thursday. */
const DAYS_PER_WEEK = 7;
const THURSDAY = 4;
const MS_PER_DAY = 86_400_000;
const WEEK_DIGITS = 2;

/** `KEY=value` in a `.env` file, with the value still to be trimmed. */
const ENV_LINE_PATTERN = /^\s*([A-Z0-9_]+)\s*=\s*(.*)$/;

/** A trailing ` # comment`, which systemd does not allow and dotenv does. */
const ENV_COMMENT_PATTERN = /\s+#.*$/;

/** A value wrapped in matching quotes. */
const ENV_QUOTED_PATTERN = /^["'](.*)["']$/;

/** The leading `/` of a URL path, so what is left is the database name. */
const LEADING_SLASH_PATTERN = /^\//;

/** Anything that cannot appear unquoted in a Postgres identifier. */
const NON_IDENTIFIER_PATTERN = /[^a-z0-9]/gi;

/** `pg_dump --version` says its own name first; the version is the rest. */
const PG_DUMP_BANNER_PATTERN = /^pg_dump\s*\(PostgreSQL\)\s*/;

/** The first run of digits, which for any of these banners is the major. */
const MAJOR_VERSION_PATTERN = /(\d+)/;

/** The gap between `du -sh`'s size and the path it measured. */
const WHITESPACE_PATTERN = /\s+/;

/** Exact row counts for every table in `public`, in one round trip.
 *
 * `pg_stat_user_tables.n_live_tup` is an estimate the planner maintains, and an
 * estimate cannot answer "did every row survive the restore". `query_to_xml`
 * runs a real `count(*)` per table inside one query, which is affordable at this
 * size and is the only thing a verification can honestly compare.
 */
const COUNTS_QUERY = `select table_name || ',' ||
  (xpath('/row/c/text()', query_to_xml(format('select count(*) as c from %I.%I', table_schema, table_name), false, true, '')))[1]::text
from information_schema.tables
where table_schema = 'public' and table_type = 'BASE TABLE'
order by table_name`;

const args = process.argv.slice(2);
const [rawCommand] = args;

/** True when `flag` appears anywhere in argv. */
const hasFlag = (flag: string) => args.includes(flag);

/** The value after `--flag`, or undefined when the flag is absent. */
const readFlag = (flag: string) => {
  const at = args.indexOf(flag);
  return at === -1 ? undefined : args[at + 1];
};

// ---------------------------------------------------------------------------
// Pure helpers. Everything below the line runs a process; everything above it
// is what `backup.test.ts` can hold still.
// ---------------------------------------------------------------------------

/** `YYYY-MM-DD` in UTC. A backup names the day it covers, in one timezone. */
export const utcDay = (at: Date) => at.toISOString().slice(0, 10);

/**
 * `YYYY-Www` in UTC, by ISO 8601: weeks start Monday and week 1 is the one
 * holding the first Thursday. Naming a week by its own year matters at the
 * boundary — 2027-01-01 is a Friday, and it belongs to 2026-W53.
 */
export const isoWeek = (at: Date) => {
  const date = new Date(
    Date.UTC(at.getUTCFullYear(), at.getUTCMonth(), at.getUTCDate())
  );
  // Move to the Thursday of this week; its year is the ISO year by definition.
  const dayOfWeek = date.getUTCDay() || DAYS_PER_WEEK;
  date.setUTCDate(date.getUTCDate() + THURSDAY - dayOfWeek);
  const yearStart = new Date(Date.UTC(date.getUTCFullYear(), 0, 1));
  const week = Math.ceil(
    ((date.getTime() - yearStart.getTime()) / MS_PER_DAY + 1) / DAYS_PER_WEEK
  );
  return `${date.getUTCFullYear()}-W${String(week).padStart(WEEK_DIGITS, "0")}`;
};

/**
 * Which of `names` to keep and which to drop, newest first.
 *
 * Names are day or week stamps, so lexical order is chronological order and
 * there is no date parsing to get wrong. Anything not matching the pattern is
 * neither kept nor dropped: a prune that deletes a directory it does not
 * recognise is a prune that eventually deletes something it should not have.
 */
export const partitionByAge = (input: {
  readonly keep: number;
  readonly names: readonly string[];
  readonly pattern: RegExp;
}) => {
  const known = input.names.filter((name) => input.pattern.test(name)).sort();
  const cut = Math.max(0, known.length - input.keep);
  return { drop: known.slice(0, cut), keep: known.slice(cut).reverse() };
};

/** What a connection string says, split into the parts libpq wants as env. */
export interface Connection {
  readonly database: string;
  readonly host: string;
  readonly password: string;
  readonly port: string;
  readonly user: string;
}

/**
 * `DATABASE_URL`, split.
 *
 * The parts go to child processes as environment variables rather than back
 * into a connection string on the command line, because the password would
 * otherwise be in `ps` output for every user on the box.
 */
export const parseDatabaseUrl = (raw: string): Connection => {
  const url = new URL(raw);
  const database = decodeURIComponent(
    url.pathname.replace(LEADING_SLASH_PATTERN, "")
  );
  if (database === "") {
    throw new Error("DATABASE_URL names no database");
  }
  return {
    database,
    host: url.hostname === "" ? "127.0.0.1" : url.hostname,
    password: decodeURIComponent(url.password),
    port: url.port === "" ? "5432" : url.port,
    user: decodeURIComponent(url.username),
  };
};

/** `name,count` lines from psql, as a map. */
export const parseCounts = (stdout: string): Record<string, number> => {
  const counts: Record<string, number> = {};
  for (const line of stdout.split("\n")) {
    const trimmed = line.trim();
    if (trimmed === "") {
      continue;
    }
    const comma = trimmed.lastIndexOf(",");
    if (comma === -1) {
      continue;
    }
    const table = trimmed.slice(0, comma);
    const count = Number(trimmed.slice(comma + 1));
    if (Number.isFinite(count)) {
      counts[table] = count;
    }
  }
  return counts;
};

/** One table where the restored database and the manifest disagree. */
export interface CountMismatch {
  readonly expected: number | null;
  readonly restored: number | null;
  readonly table: string;
}

/**
 * Every table where the two count maps differ, including tables present in one
 * and missing from the other — a restore that silently dropped a table is
 * exactly the failure this is looking for.
 */
export const compareCounts = (input: {
  readonly expected: Record<string, number>;
  readonly restored: Record<string, number>;
}): readonly CountMismatch[] => {
  const tables = [
    ...new Set([
      ...Object.keys(input.expected),
      ...Object.keys(input.restored),
    ]),
  ].sort();
  return tables
    .map((table) => ({
      expected: input.expected[table] ?? null,
      restored: input.restored[table] ?? null,
      table,
    }))
    .filter((row) => row.expected !== row.restored);
};

/** Lines of `pg_restore --list` that are archive entries rather than comments. */
export const tocEntryCount = (listing: string) =>
  listing
    .split("\n")
    .filter((line) => line.trim() !== "" && !line.startsWith(";")).length;

/** Bytes, as something a person reads at 3am. */
export const humanBytes = (bytes: number) => {
  const units = ["B", "KB", "MB", "GB"];
  let value = bytes;
  let unit = 0;
  while (value >= BYTES_PER_UNIT && unit < units.length - 1) {
    value /= BYTES_PER_UNIT;
    unit += 1;
  }
  return `${unit === 0 ? value : value.toFixed(1)} ${units[unit]}`;
};

/** The scratch database a verification restores into. */
export const scratchDatabaseName = (input: {
  readonly pid: number;
  readonly setName: string;
}) =>
  `atm_restore_check_${input.setName.replace(NON_IDENTIFIER_PATTERN, "_").toLowerCase()}_${input.pid}`;

// ---------------------------------------------------------------------------
// Configuration.
// ---------------------------------------------------------------------------

/** `.env` in the checkout, for the values systemd's environment files do not set. */
const loadDotEnv = () => {
  const path = join(REPO_DIR, ".env");
  if (!existsSync(path)) {
    return;
  }
  for (const line of readFileSync(path, "utf8").split("\n")) {
    const match = ENV_LINE_PATTERN.exec(line);
    if (match?.[1] === undefined) {
      continue;
    }
    // The loader the apps use does not override a value already set, and
    // neither does this: under systemd the environment file is the answer.
    if (process.env[match[1]] === undefined) {
      process.env[match[1]] = (match[2] ?? "")
        .replace(ENV_COMMENT_PATTERN, "")
        .trim()
        .replace(ENV_QUOTED_PATTERN, "$1");
    }
  }
};

loadDotEnv();

const dataRoot = resolve(REPO_DIR, process.env.DATA_ROOT ?? ".data");

/**
 * Where the sets live. Beside `DATA_ROOT`, never inside it — the same reason
 * `/var/lib/agent-task-manager-home` is a sibling rather than a subdirectory,
 * and the reason a data root that has to be deleted can be.
 */
const backupRoot = resolve(
  REPO_DIR,
  process.env.ATM_BACKUP_ROOT ?? `${dataRoot}-backups`
);

/**
 * A retention count from the environment.
 *
 * A typo here is the kind of thing nobody finds out about: `Number("fourteen")`
 * is `NaN`, and a `NaN` window silently keeps everything until the disk fills.
 * Refusing at the top of the run is the only version of this that is visible.
 */
const keepCount = (name: string, fallback: number) => {
  const raw = process.env[name];
  if (raw === undefined || raw === "") {
    return fallback;
  }
  const parsed = Number(raw);
  if (!(Number.isInteger(parsed) && parsed > 0)) {
    throw new Error(`${name} must be a positive whole number, not ${raw}`);
  }
  return parsed;
};

// Read where `prune` runs rather than at import, so a bad value is the command
// failing with that one line and not a stack trace out of module evaluation.

const dailyRoot = join(backupRoot, "daily");
const weeklyRoot = join(backupRoot, "weekly");

// ---------------------------------------------------------------------------
// Running things.
// ---------------------------------------------------------------------------

interface RunOptions {
  /** Extra environment for the child, on top of this process's. */
  readonly env?: Record<string, string>;
  /** A file to feed the child on stdin. */
  readonly stdinFile?: string;
  /** A file to send the child's stdout to, instead of capturing it. */
  readonly stdoutFile?: string;
}

interface RunResult {
  readonly code: number;
  readonly stderr: string;
  readonly stdout: string;
}

/** One command, with its streams pointed where the caller wants them. */
const run = (argv: readonly string[], options: RunOptions = {}): RunResult => {
  const opened: number[] = [];
  const openFile = (path: string, flags: string, mode?: number) => {
    const fd = openSync(path, flags, mode);
    opened.push(fd);
    return fd;
  };
  try {
    const stdin = options.stdinFile
      ? openFile(options.stdinFile, "r")
      : "ignore";
    const stdout = options.stdoutFile
      ? openFile(options.stdoutFile, "w", FILE_MODE)
      : "pipe";
    const result = spawnSync(argv[0] ?? "", argv.slice(1), {
      encoding: "utf8",
      env: { ...process.env, ...options.env },
      maxBuffer: MAX_CAPTURED_BYTES,
      stdio: [stdin, stdout, "pipe"],
    });
    return {
      code: result.status ?? 1,
      // A binary that is not on PATH does not exit non-zero, it fails to
      // start: `status` is null and `stderr` is null with it. Without
      // `result.error` here that failure reads as "pg_dump exited 1:" and
      // names nothing.
      stderr: (result.stderr ?? result.error?.message ?? "").trim(),
      stdout: (result.stdout ?? "").trim(),
    };
  } finally {
    for (const fd of opened) {
      closeSync(fd);
    }
  }
};

/** A command that must succeed, with its stderr on the failure. */
const mustRun = (argv: readonly string[], options: RunOptions = {}) => {
  const result = run(argv, options);
  if (result.code !== 0) {
    throw new Error(
      `${argv[0]} exited ${result.code}: ${result.stderr || result.stdout}`
    );
  }
  return result;
};

/**
 * How this host reaches Postgres.
 *
 * `compose` execs the client inside the database's own container, so the client
 * is the server's binary and no version can be wrong. `host` runs the client on
 * this machine against `DATABASE_URL`.
 */
type Channel = "compose" | "host";

/** One client tool, as this channel would invoke it. */
interface Invocation {
  readonly argv: readonly string[];
  readonly env: Record<string, string>;
}

interface Client {
  readonly channel: Channel;
  /**
   * `pg_dump`, `psql`, `pg_restore`, … as a full argv plus the environment it
   * needs. `database` overrides the one in `DATABASE_URL`, which the scratch
   * restore and every `createdb` needs — and which has to be built by the
   * channel rather than set on this process, because a variable exported here
   * does not cross into a container.
   */
  readonly command: (input: {
    readonly args: readonly string[];
    readonly database?: string;
    readonly tool: string;
  }) => Invocation;
}

/** Whether Compose reports the Postgres service running here. */
const composeIsRunning = () => {
  const probe = run([
    "docker",
    "compose",
    "--project-directory",
    REPO_DIR,
    "ps",
    "--status",
    "running",
    "--format",
    "{{.Service}}",
  ]);
  return (
    probe.code === 0 &&
    probe.stdout.split("\n").some((line) => line.trim() === COMPOSE_SERVICE)
  );
};

/** The client to use, honouring `ATM_BACKUP_PG` when it names one. */
const resolveClient = (connection: Connection): Client => {
  const forced = process.env.ATM_BACKUP_PG;
  if (forced !== undefined && forced !== "compose" && forced !== "host") {
    throw new Error(`ATM_BACKUP_PG must be compose or host, not ${forced}`);
  }
  const useCompose =
    forced === "compose" || (forced === undefined && composeIsRunning());

  if (useCompose) {
    return {
      channel: "compose",
      command: ({ args: toolArgs, database, tool }) => ({
        // Inside the container the client reaches Postgres over the unix
        // socket, which the official image's pg_hba trusts, so no password is
        // passed and none can leak.
        argv: [
          "docker",
          "compose",
          "--project-directory",
          REPO_DIR,
          "exec",
          "-T",
          "-e",
          `PGUSER=${connection.user}`,
          "-e",
          `PGDATABASE=${database ?? connection.database}`,
          COMPOSE_SERVICE,
          tool,
          ...toolArgs,
        ],
        env: {},
      }),
    };
  }

  return {
    channel: "host",
    command: ({ args: toolArgs, database, tool }) => ({
      argv: [tool, ...toolArgs],
      env: {
        PGDATABASE: database ?? connection.database,
        PGHOST: connection.host,
        PGPASSWORD: connection.password,
        PGPORT: connection.port,
        PGUSER: connection.user,
      },
    }),
  };
};

interface PgOptions extends RunOptions {
  /** Connect to this database instead of the one in `DATABASE_URL`. */
  readonly database?: string;
}

/** Runs a Postgres client tool through the chosen channel. */
const pg = (
  client: Client,
  tool: string,
  toolArgs: readonly string[],
  options: PgOptions = {}
) => {
  const { argv, env } = client.command({
    args: toolArgs,
    database: options.database,
    tool,
  });
  return run(argv, { ...options, env: { ...env, ...options.env } });
};

/** The same, insisting on success. */
const mustPg = (
  client: Client,
  tool: string,
  toolArgs: readonly string[],
  options: PgOptions = {}
) => {
  const result = pg(client, tool, toolArgs, options);
  if (result.code !== 0) {
    throw new Error(
      `${tool} exited ${result.code}: ${result.stderr || result.stdout}`
    );
  }
  return result;
};

/** One `psql` query, unaligned and untitled, so parsing it is unambiguous. */
const query = (client: Client, sql: string, database?: string) =>
  mustPg(
    client,
    "psql",
    ["-X", "-A", "-t", "-v", "ON_ERROR_STOP=1", "-c", sql],
    { database }
  ).stdout;

/**
 * Refuses a host client older than the server.
 *
 * `pg_dump` says this itself and then exits, but it says it at 03:20 into a
 * journal nobody is reading. Saying it here means the same failure is one line
 * at the top of the run rather than a stack of retries.
 */
const assertClientNotOlder = (client: Client) => {
  const server = query(client, "show server_version");
  const dump = mustPg(client, "pg_dump", ["--version"])
    .stdout.replace(PG_DUMP_BANNER_PATTERN, "")
    .trim();
  const majorOf = (text: string) =>
    Number(MAJOR_VERSION_PATTERN.exec(text)?.[1] ?? "0");
  if (majorOf(dump) < majorOf(server)) {
    throw new Error(
      `pg_dump is ${dump} and the server is ${server} — a client older than the server refuses to dump. Install postgresql-client-${majorOf(server)}, or run Postgres under Compose so the container's own client is used.`
    );
  }
  return { pgDumpVersion: dump, serverVersion: server };
};

// ---------------------------------------------------------------------------
// The backup set.
// ---------------------------------------------------------------------------

/** Every file under `dir`, with its size. Symlinks are not followed. */
const walk = (dir: string): { files: number; bytes: number } => {
  let files = 0;
  let bytes = 0;
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) {
      const inner = walk(path);
      files += inner.files;
      bytes += inner.bytes;
    } else if (entry.isFile()) {
      files += 1;
      bytes += statSync(path).size;
    }
  }
  return { bytes, files };
};

const sha256 = (path: string) =>
  createHash("sha256").update(readFileSync(path)).digest("hex");

const sizeOf = (path: string) => statSync(path).size;

/** What one set records about itself. `verify` reads this and nothing else. */
interface Manifest {
  readonly artifacts: {
    readonly bytes: number;
    readonly files: number;
    readonly present: boolean;
    readonly root: string;
    readonly sha256: string | null;
    readonly tarBytes: number | null;
  };
  readonly channel: Channel;
  readonly database: {
    readonly dumpBytes: number;
    readonly name: string;
    readonly pgDumpVersion: string;
    readonly rowCounts: Record<string, number>;
    readonly serverVersion: string;
    readonly sha256: string;
    readonly tocEntries: number;
  };
  readonly day: string;
  readonly globals: { readonly bytes: number; readonly sha256: string };
  readonly isoWeek: string;
  readonly seconds: number;
  readonly takenAt: string;
  readonly version: 1;
}

/** Takes the lock, so a manual run and the timer cannot interleave. */
const withLock = <A>(body: () => A): A => {
  mkdirSync(backupRoot, { mode: DIR_MODE, recursive: true });
  const lock = join(backupRoot, ".lock");
  try {
    mkdirSync(lock);
  } catch (error) {
    throw new Error(
      `${lock} exists — another backup is running, or one was killed. Remove it if nothing is.`,
      { cause: error }
    );
  }
  try {
    writeFileSync(join(lock, "pid"), `${process.pid}\n`, { mode: FILE_MODE });
    return body();
  } finally {
    rmSync(lock, { force: true, recursive: true });
  }
};

/** Replaces `target` with `staged`, without ever leaving neither in place. */
const swapIn = (input: {
  readonly staged: string;
  readonly target: string;
}) => {
  const previous = `${input.target}.previous`;
  rmSync(previous, { force: true, recursive: true });
  if (existsSync(input.target)) {
    renameSync(input.target, previous);
  }
  renameSync(input.staged, input.target);
  rmSync(previous, { force: true, recursive: true });
};

/** Hardlinks a set under `weekly/`, so a week costs no bytes until it ages out. */
const anchorWeek = (input: { readonly day: string; readonly week: string }) => {
  const source = join(dailyRoot, input.day);
  const staged = join(weeklyRoot, `.staging-${input.week}`);
  mkdirSync(weeklyRoot, { mode: DIR_MODE, recursive: true });
  rmSync(staged, { force: true, recursive: true });
  mkdirSync(staged, { mode: DIR_MODE, recursive: true });
  for (const file of SET_FILES) {
    const from = join(source, file);
    if (existsSync(from)) {
      linkSync(from, join(staged, file));
    }
  }
  // Relinked on every run in the week rather than written once, so the weekly
  // set is the last backup of its week and not the first — by the time the week
  // has rolled over, that is the freshest copy it could hold.
  swapIn({ staged, target: join(weeklyRoot, input.week) });
};

/** Deletes what falls outside the window, and says what it deleted. */
const prune = () => {
  const removed: string[] = [];
  for (const [root, keep, pattern] of [
    [
      dailyRoot,
      keepCount("ATM_BACKUP_KEEP_DAILY", DEFAULT_KEEP_DAILY),
      DAY_PATTERN,
    ],
    [
      weeklyRoot,
      keepCount("ATM_BACKUP_KEEP_WEEKLY", DEFAULT_KEEP_WEEKLY),
      WEEK_PATTERN,
    ],
  ] as const) {
    if (!existsSync(root)) {
      continue;
    }
    const { drop } = partitionByAge({
      keep,
      names: readdirSync(root),
      pattern,
    });
    for (const name of drop) {
      rmSync(join(root, name), { force: true, recursive: true });
      removed.push(`${basename(root)}/${name}`);
    }
  }
  return removed;
};

/** Dumps, tars, verifies what can be verified cheaply, links and prunes. */
const take = () => {
  const startedAt = Date.now();
  const now = new Date();
  const day = utcDay(now);
  const week = isoWeek(now);

  const databaseUrl = process.env.DATABASE_URL;
  if (databaseUrl === undefined || databaseUrl === "") {
    process.stderr.write(
      "DATABASE_URL is not set. It is in common.env on a deployed host and in .env in a checkout.\n"
    );
    return 1;
  }
  const connection = parseDatabaseUrl(databaseUrl);
  const client = resolveClient(connection);
  const versions = assertClientNotOlder(client);

  process.stdout.write(
    `postgres ${versions.serverVersion} over ${client.channel}, pg_dump ${versions.pgDumpVersion}\n`
  );

  return withLock(() => {
    mkdirSync(dailyRoot, { mode: DIR_MODE, recursive: true });
    const staged = join(dailyRoot, `.staging-${day}`);
    rmSync(staged, { force: true, recursive: true });
    mkdirSync(staged, { mode: DIR_MODE, recursive: true });

    // Counted before the dump rather than after, so a mismatch at verify time
    // means the restore lost rows and not that a run wrote some in between.
    const rowCounts = parseCounts(query(client, COUNTS_QUERY));

    const dumpPath = join(staged, DUMP_FILE);
    mustPg(
      client,
      "pg_dump",
      // Custom format because it is the only one `pg_restore` can be selective
      // over, and compressed because the dump is mostly JSON columns. Ownership
      // and grants stay in the archive; `--no-owner` belongs on the restore,
      // where the role that will own the rows is actually known.
      ["--format=custom", "--compress=9"],
      { stdoutFile: dumpPath }
    );

    // Roles and their passwords. `pg_dump` carries neither, so a restore onto a
    // fresh host without this is a database nothing can log into.
    const globalsPath = join(staged, GLOBALS_FILE);
    mustPg(client, "pg_dumpall", ["--globals-only"], {
      stdoutFile: globalsPath,
    });

    const listing = mustPg(client, "pg_restore", ["--list"], {
      stdinFile: dumpPath,
    }).stdout;
    const tocEntries = tocEntryCount(listing);

    const artifactsDir = join(dataRoot, "artifacts");
    const artifactsPresent = existsSync(artifactsDir);
    const walked = artifactsPresent
      ? walk(artifactsDir)
      : { bytes: 0, files: 0 };
    const artifactsPath = join(staged, ARTIFACTS_FILE);
    if (artifactsPresent) {
      mustRun([
        "tar",
        "--create",
        "--gzip",
        "--file",
        artifactsPath,
        "--directory",
        dataRoot,
        "artifacts",
      ]);
      // `tar` writes through the umask, and the artifact tree is as much a
      // secret as the dump is.
      chmodSync(artifactsPath, FILE_MODE);
    }

    const manifest: Manifest = {
      artifacts: {
        bytes: walked.bytes,
        files: walked.files,
        present: artifactsPresent,
        root: artifactsDir,
        sha256: artifactsPresent ? sha256(artifactsPath) : null,
        tarBytes: artifactsPresent ? sizeOf(artifactsPath) : null,
      },
      channel: client.channel,
      database: {
        dumpBytes: sizeOf(dumpPath),
        name: connection.database,
        pgDumpVersion: versions.pgDumpVersion,
        rowCounts,
        serverVersion: versions.serverVersion,
        sha256: sha256(dumpPath),
        tocEntries,
      },
      day,
      globals: { bytes: sizeOf(globalsPath), sha256: sha256(globalsPath) },
      isoWeek: week,
      seconds: Math.round((Date.now() - startedAt) / MS_PER_TENTH) / TENTHS,
      takenAt: now.toISOString(),
      version: 1,
    };
    writeFileSync(
      join(staged, MANIFEST_FILE),
      `${JSON.stringify(manifest, null, JSON_INDENT)}\n`,
      { mode: FILE_MODE }
    );

    swapIn({ staged, target: join(dailyRoot, day) });
    anchorWeek({ day, week });
    const removed = prune();

    const tables = Object.keys(rowCounts).length;
    const rows = Object.values(rowCounts).reduce((sum, n) => sum + n, 0);
    process.stdout.write(
      `daily/${day}  ${DUMP_FILE} ${humanBytes(manifest.database.dumpBytes)}, ${rows} rows over ${tables} tables\n`
    );
    process.stdout.write(
      artifactsPresent
        ? `daily/${day}  ${ARTIFACTS_FILE} ${humanBytes(manifest.artifacts.tarBytes ?? 0)}, ${walked.files} files (${humanBytes(walked.bytes)} on disk)\n`
        : `daily/${day}  no ${artifactsDir}, nothing to archive\n`
    );
    process.stdout.write(`weekly/${week}  hardlinked to daily/${day}\n`);
    if (removed.length > 0) {
      process.stdout.write(`pruned ${removed.join(", ")}\n`);
    }
    process.stdout.write(
      `table of contents readable, ${tocEntries} entries — a readability check, not a restore. Run \`bun run backup:verify\` for that.\n`
    );
    process.stdout.write(`took ${manifest.seconds}s\n`);
    return 0;
  });
};

// ---------------------------------------------------------------------------
// Reading what is there.
// ---------------------------------------------------------------------------

/** Every set on disk, newest first, with the manifest each carries. */
const sets = () => {
  const read = (root: string, pattern: RegExp) => {
    if (!existsSync(root)) {
      return [];
    }
    const { keep } = partitionByAge({
      keep: Number.POSITIVE_INFINITY,
      names: readdirSync(root),
      pattern,
    });
    return keep.map((name) => {
      const path = join(root, name);
      const manifestPath = join(path, MANIFEST_FILE);
      const manifest = existsSync(manifestPath)
        ? (JSON.parse(readFileSync(manifestPath, "utf8")) as Manifest)
        : null;
      return { kind: basename(root), manifest, name, path };
    });
  };
  return [...read(dailyRoot, DAY_PATTERN), ...read(weeklyRoot, WEEK_PATTERN)];
};

const list = () => {
  const all = sets();
  if (hasFlag("--json")) {
    process.stdout.write(`${JSON.stringify(all, null, JSON_INDENT)}\n`);
    return 0;
  }
  if (all.length === 0) {
    process.stdout.write(`nothing in ${backupRoot}\n`);
    return 0;
  }
  process.stdout.write(`${backupRoot}\n`);
  // Hardlinked weekly sets share inodes with the daily ones, so this is what
  // the tree costs and not the sum of what the manifests report.
  const [onDisk] = run(["du", "-sh", backupRoot]).stdout.split(
    WHITESPACE_PATTERN
  );
  for (const set of all) {
    const size =
      set.manifest === null
        ? "no manifest"
        : `${humanBytes(set.manifest.database.dumpBytes + (set.manifest.artifacts.tarBytes ?? 0))}`;
    const rows =
      set.manifest === null
        ? ""
        : `  ${Object.values(set.manifest.database.rowCounts).reduce((sum, n) => sum + n, 0)} rows`;
    process.stdout.write(
      `  ${set.kind}/${set.name}  ${set.manifest?.takenAt ?? "?"}  ${size}${rows}\n`
    );
  }
  process.stdout.write(`${onDisk ?? "?"} on disk, hardlinks counted once\n`);
  return 0;
};

// ---------------------------------------------------------------------------
// The restore.
// ---------------------------------------------------------------------------

/** One set on disk that carries a manifest, which is the only kind worth checking. */
interface VerifiableSet {
  readonly kind: string;
  readonly manifest: Manifest;
  readonly name: string;
  readonly path: string;
}

/** Whether the files are the bytes the manifest says they are. */
const checkDigests = (set: VerifiableSet): readonly string[] => {
  const problems: string[] = [];
  const dumpDigest = sha256(join(set.path, DUMP_FILE));
  if (dumpDigest === set.manifest.database.sha256) {
    process.stdout.write(`  ${DUMP_FILE} sha256 matches the manifest\n`);
  } else {
    problems.push(
      `${DUMP_FILE} sha256 is ${dumpDigest}, manifest says ${set.manifest.database.sha256}`
    );
  }
  if (sha256(join(set.path, GLOBALS_FILE)) !== set.manifest.globals.sha256) {
    problems.push(`${GLOBALS_FILE} sha256 does not match the manifest`);
  }
  return problems;
};

/**
 * Restores the archive into a scratch database and counts what came back.
 *
 * The scratch database is dropped whether this passed or failed — one left
 * behind on a failure is a second problem on top of the first.
 */
const checkRestore = (input: {
  readonly client: Client;
  readonly set: VerifiableSet;
}): readonly string[] => {
  const { client, set } = input;
  const problems: string[] = [];
  const scratch = scratchDatabaseName({
    pid: process.pid,
    setName: `${set.kind}_${set.name}`,
  });
  // `createdb` and `dropdb` take the database they act on as a positional
  // argument and connect to a *different* one to do it — `--maintenance-db`,
  // named here rather than left to `PGDATABASE`, which they would otherwise
  // read as the database to create.
  const maintenance = "postgres";
  mustPg(client, "createdb", ["--maintenance-db", maintenance, scratch]);
  try {
    const restored = pg(
      client,
      "pg_restore",
      ["--dbname", scratch, "--no-owner", "--no-privileges", "--exit-on-error"],
      { stdinFile: join(set.path, DUMP_FILE) }
    );
    if (restored.code === 0) {
      process.stdout.write(`  restored into ${scratch}\n`);
    } else {
      problems.push(`pg_restore exited ${restored.code}: ${restored.stderr}`);
    }

    const counts = parseCounts(query(client, COUNTS_QUERY, scratch));
    const mismatches = compareCounts({
      expected: set.manifest.database.rowCounts,
      restored: counts,
    });
    if (mismatches.length === 0) {
      const rows = Object.values(counts).reduce((sum, n) => sum + n, 0);
      process.stdout.write(
        `  ${rows} rows over ${Object.keys(counts).length} tables, every count as dumped\n`
      );
    }
    for (const row of mismatches) {
      problems.push(
        `${row.table}: dumped ${row.expected ?? "absent"}, restored ${row.restored ?? "absent"}`
      );
    }
  } finally {
    const dropped = pg(client, "dropdb", [
      "--maintenance-db",
      maintenance,
      "--if-exists",
      scratch,
    ]);
    if (dropped.code === 0) {
      process.stdout.write(`  dropped ${scratch}\n`);
    } else {
      problems.push(`could not drop ${scratch}: ${dropped.stderr}`);
    }
  }
  return problems;
};

/**
 * Unpacks the artifact tar somewhere disposable and counts what came out.
 *
 * Counted rather than listed, because a tar whose index lists cleanly can still
 * have been truncated part way through a member.
 */
const checkArtifacts = (set: VerifiableSet): readonly string[] => {
  if (!set.manifest.artifacts.present) {
    process.stdout.write("  no artifacts in this set\n");
    return [];
  }
  const problems: string[] = [];
  const tarPath = join(set.path, ARTIFACTS_FILE);
  if (sha256(tarPath) !== set.manifest.artifacts.sha256) {
    problems.push(`${ARTIFACTS_FILE} sha256 does not match the manifest`);
  }
  const into = join(backupRoot, `.verify-${process.pid}`);
  rmSync(into, { force: true, recursive: true });
  mkdirSync(into, { mode: DIR_MODE, recursive: true });
  try {
    mustRun([
      "tar",
      "--extract",
      "--gzip",
      "--file",
      tarPath,
      "--directory",
      into,
    ]);
    const walked = walk(join(into, "artifacts"));
    if (
      walked.files === set.manifest.artifacts.files &&
      walked.bytes === set.manifest.artifacts.bytes
    ) {
      process.stdout.write(
        `  ${ARTIFACTS_FILE} unpacks to ${walked.files} files, ${humanBytes(walked.bytes)}, as recorded\n`
      );
    } else {
      problems.push(
        `${ARTIFACTS_FILE} unpacks to ${walked.files} files / ${walked.bytes} bytes, manifest says ${set.manifest.artifacts.files} / ${set.manifest.artifacts.bytes}`
      );
    }
  } finally {
    rmSync(into, { force: true, recursive: true });
  }
  return problems;
};

/** The set `--at` names, or the newest daily one. */
const chooseSet = (named: string | undefined) => {
  const all = sets();
  return named === undefined
    ? all.find((set) => set.kind === "daily")
    : all.find(
        (set) => `${set.kind}/${set.name}` === named || set.name === named
      );
};

/**
 * Restores a set into a scratch database and compares it to the manifest.
 *
 * This is the only command here that proves anything: the archive goes back
 * into a real Postgres, every table is counted, and every count is checked
 * against the one taken immediately before the dump.
 */
const verify = () => {
  const databaseUrl = process.env.DATABASE_URL;
  if (databaseUrl === undefined || databaseUrl === "") {
    process.stderr.write("DATABASE_URL is not set.\n");
    return 1;
  }
  const client = resolveClient(parseDatabaseUrl(databaseUrl));

  const named = readFlag("--at");
  const chosen = chooseSet(named);
  if (chosen === undefined) {
    process.stderr.write(
      named === undefined
        ? `no daily set in ${backupRoot}\n`
        : `no set called ${named} in ${backupRoot}\n`
    );
    return 1;
  }
  if (chosen.manifest === null) {
    process.stderr.write(`${chosen.path} has no ${MANIFEST_FILE}\n`);
    return 1;
  }
  const set: VerifiableSet = { ...chosen, manifest: chosen.manifest };
  process.stdout.write(
    `${set.kind}/${set.name}, taken ${set.manifest.takenAt} over ${set.manifest.channel}\n`
  );

  const problems = [
    ...checkDigests(set),
    ...checkRestore({ client, set }),
    ...checkArtifacts(set),
  ];

  if (problems.length === 0) {
    process.stdout.write("restore verified\n");
    return 0;
  }
  for (const problem of problems) {
    process.stderr.write(`  ${problem}\n`);
  }
  process.stderr.write(`restore FAILED, ${problems.length} problem(s)\n`);
  return 1;
};

// ---------------------------------------------------------------------------

const usage = `Usage: bun run backup [command]

  take             dump the database and the artifact tree, prune, write a manifest
  list [--json]    what is on disk
  verify [--at <set>]  restore a set into a scratch database and check every row count
  prune            apply the retention window and nothing else

  ATM_BACKUP_ROOT         where sets live, default <DATA_ROOT>-backups
  ATM_BACKUP_KEEP_DAILY   default ${DEFAULT_KEEP_DAILY}
  ATM_BACKUP_KEEP_WEEKLY  default ${DEFAULT_KEEP_WEEKLY}
  ATM_BACKUP_PG           compose or host, default whichever Compose is running`;

const commands: Record<string, () => number> = {
  list,
  prune: () => {
    const removed = withLock(prune);
    process.stdout.write(
      removed.length === 0
        ? "nothing to prune\n"
        : `pruned ${removed.join(", ")}\n`
    );
    return 0;
  },
  take,
  verify,
};

// Guarded, because `backup.test.ts` imports the helpers above and a module
// that took a backup on import would take one every time the suite ran.
if (import.meta.main) {
  const command = rawCommand ?? "take";

  if (command === "help" || command === "--help") {
    process.stdout.write(`${usage}\n`);
    process.exit(0);
  }

  const handler = commands[command];
  if (handler === undefined) {
    process.stderr.write(`unknown command ${command}\n\n${usage}\n`);
    process.exit(1);
  }

  try {
    process.exit(handler());
  } catch (error) {
    process.stderr.write(
      `${error instanceof Error ? error.message : String(error)}\n`
    );
    process.exit(1);
  }
}
