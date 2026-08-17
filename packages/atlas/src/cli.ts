/**
 * `bun run atlas [--out DIR] [--open] [--help]` — extract, render, write, report.
 *
 * Exits 0 on success, 1 on a bad flag or a write failure, 2 when the checker
 * server dies mid-walk. The report is what the run measured, not a summary of
 * it: how long the snapshot took, how many files and exports the walk saw, and
 * one count per node and edge kind, so a change in the codebase shows up as a
 * change in a number rather than in a picture nobody diffs.
 */

import { existsSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import { dirname, isAbsolute, resolve } from "node:path";
import { extractGraph, type SnapshotInfo } from "./extract";
import { SessionLost } from "./extract/effect";
import { type AtlasGraph, EDGE_KINDS, NODE_KINDS } from "./graph";
import { renderHtml } from "./render";

const DEFAULT_OUT = ".atlas";

const EXIT_BAD_USAGE = 1;
const EXIT_SESSION_LOST = 2;

const USAGE = `usage: bun run atlas [--out DIR] [--open]

  --out DIR   where to write graph.json and atlas.html. default: ${DEFAULT_OUT}
  --open      open the page afterwards. macOS only; elsewhere the path is printed
  --help      this`;

interface Flags {
  readonly help: boolean;
  readonly open: boolean;
  readonly out: string;
}

/** Parses the argument list, or says what is wrong with it. */
export const parseFlags = (
  argv: readonly string[]
): { readonly flags: Flags } | { readonly error: string } => {
  let out = DEFAULT_OUT;
  let open = false;
  let help = false;
  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index];
    if (flag === "--help" || flag === "-h") {
      help = true;
      continue;
    }
    if (flag === "--open") {
      open = true;
      continue;
    }
    if (flag === "--out") {
      const value = argv[index + 1];
      if (!value || value.startsWith("--")) {
        return { error: "--out needs a directory" };
      }
      out = value;
      index += 1;
      continue;
    }
    return { error: `unknown flag: ${flag}` };
  }
  return { flags: { help, open, out } };
};

/**
 * The repo root: the nearest ancestor declaring workspaces. Resolved from this
 * file rather than the cwd, so `bun run --cwd packages/atlas` maps the repo and
 * not the package.
 */
export const findRoot = (from: string) => {
  let dir = from;
  while (dir !== dirname(dir)) {
    if (existsSync(`${dir}/bun.lock`) && existsSync(`${dir}/turbo.json`)) {
      return dir;
    }
    dir = dirname(dir);
  }
  return from;
};

const counts = (graph: AtlasGraph, kinds: readonly string[]) =>
  kinds
    .map((kind) => `${kind} ${graph.stats[kind as keyof typeof graph.stats]}`)
    .join(" · ");

const report = ({
  graph,
  html,
  json,
  snapshot,
}: {
  readonly graph: AtlasGraph;
  readonly html: string;
  readonly json: string;
  readonly snapshot: SnapshotInfo;
}) => {
  const lines = [
    `snapshot projects ${snapshot.projects} · ${snapshot.ms} ms`,
    `walk    files ${graph.stats.files} · exports ${graph.stats.exports} · ${graph.stats.ms} ms`,
    `nodes   ${counts(graph, NODE_KINDS)}`,
    `edges   ${counts(graph, EDGE_KINDS)}`,
    `unresolved: ${graph.unresolved.length}`,
    json,
    html,
  ];
  process.stdout.write(`${lines.join("\n")}\n`);
};

/** Runs the CLI to completion. Sets the process exit code itself on failure. */
export const run = async (argv: readonly string[]) => {
  const parsed = parseFlags(argv);
  if ("error" in parsed) {
    process.stderr.write(`${parsed.error}\n${USAGE}\n`);
    process.exit(EXIT_BAD_USAGE);
  }
  if (parsed.flags.help) {
    process.stdout.write(`${USAGE}\n`);
    return;
  }

  const root = findRoot(import.meta.dir);
  const { graph, snapshot } = await extract(root);
  const outDir = isAbsolute(parsed.flags.out)
    ? parsed.flags.out
    : resolve(root, parsed.flags.out);
  const json = `${outDir}/graph.json`;
  const html = `${outDir}/atlas.html`;

  // Bundled before the write, and reported apart from it: a syntax error in
  // the viewer is not a full disk, and reading one as the other costs an hour.
  const page = await renderPage(graph);

  try {
    await mkdir(outDir, { recursive: true });
    // Sorted by id inside `build`, so two runs over an unchanged tree produce
    // the same bytes and a diff reads.
    await Bun.write(json, `${JSON.stringify(graph, null, 2)}\n`);
    await Bun.write(html, page);
  } catch (error) {
    process.stderr.write(`could not write ${outDir}: ${String(error)}\n`);
    process.exit(EXIT_BAD_USAGE);
  }

  report({ graph, html, json, snapshot });
  if (parsed.flags.open) {
    await reveal(html);
  }
};

const renderPage = async (graph: AtlasGraph) => {
  try {
    return await renderHtml(graph);
  } catch (error) {
    const detail = error instanceof AggregateError ? error.errors : error;
    process.stderr.write(`could not build the viewer: ${String(detail)}\n`);
    process.exit(EXIT_BAD_USAGE);
  }
};

const extract = async (root: string) => {
  const opened: SnapshotInfo[] = [];
  try {
    const graph = await extractGraph({
      onSnapshot: (info) => opened.push(info),
      root,
    });
    return { graph, snapshot: opened[0] ?? { ms: 0, projects: 0 } };
  } catch (error) {
    if (error instanceof SessionLost) {
      process.stderr.write(`${error.message}\n`);
      process.exit(EXIT_SESSION_LOST);
    }
    throw error;
  }
};

const reveal = async (file: string) => {
  if (process.platform !== "darwin") {
    process.stdout.write(
      `--open needs macOS; open the page above yourself: file://${file}\n`
    );
    return;
  }
  await Bun.spawn(["open", file]).exited;
};
