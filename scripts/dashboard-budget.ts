/**
 * Holds the dashboard's first load to a size somebody chose.
 *
 * What it measures is the eager set: the entry module and every chunk the built
 * `index.html` tells the browser to preload. That is what a person waits for
 * before the app draws anything, and it is the number that regresses silently —
 * a static import added to a route module, a provider mounted in `app.tsx`, and
 * a screen that used to be fetched on demand is suddenly on the way to the
 * board. What is fetched on demand — the pages, the two overlays, the panels
 * behind them — is deliberately *not* counted; moving weight there is the thing
 * this file exists to encourage, and it is reported separately at the end so
 * that a first load which shrank because something was deleted does not read
 * the same as one that shrank because something was split.
 *
 * The ceiling is a ratchet, not a target. When a change genuinely needs more,
 * raise it in the same commit and say why — that edit is the review.
 *
 * Needs a build to look at: `bun run dashboard:build && bun run dashboard:budget`.
 */

import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import process from "node:process";
import { gzipSync } from "node:zlib";

/** Where `vite build` leaves the dashboard, relative to the repository root. */
const DIST = join(import.meta.dir, "..", "apps", "dashboard", "dist");

const BYTES_IN_KB = 1024;

/**
 * What a first load may cost, compressed.
 *
 * Gzip rather than raw because it is what crosses the wire, and the two do not
 * move together — a chunk of repetitive generated code can double in size and
 * barely register here. Set from a measured 257 kB with room for ordinary
 * growth, and low enough that undoing the code splitting would trip it.
 */
const BUDGET_KB = 280;

/** Exit code for a first load over budget. Non-zero: CI has to fail on it. */
const OVER_BUDGET_EXIT_CODE = 1;

/** Enough to see a chunk move without reporting bytes nobody can act on. */
const DECIMALS = 1;

/** Wide enough for the largest size this prints, so the sizes line up. */
const SIZE_COLUMN = 9;

const kb = (bytes: number) =>
  `${(bytes / BYTES_IN_KB).toFixed(DECIMALS)} kB`.padStart(SIZE_COLUMN);

/**
 * The chunks a browser fetches before the app renders.
 *
 * Read out of the built HTML rather than assembled from the module graph: the
 * `<script>` and its `modulepreload` links are the instruction the browser
 * actually follows, so whatever ends up in there is what a first load costs,
 * however it got there.
 */
const eagerChunks = (document: string) => [
  ...new Set(
    [...document.matchAll(/assets\/(?<chunk>[\w.-]+\.js)/g)].flatMap(
      (match) => match.groups?.chunk ?? []
    )
  ),
];

const html = (() => {
  try {
    return readFileSync(join(DIST, "index.html"), "utf8");
  } catch {
    process.stderr.write(
      "dashboard-budget: no build to measure — run `bun run dashboard:build`\n"
    );
    process.exit(OVER_BUDGET_EXIT_CODE);
  }
})();

const eager = eagerChunks(html);
const measured = eager.map((name) => {
  const bytes = readFileSync(join(DIST, "assets", name));
  return { gzip: gzipSync(bytes).length, name, raw: bytes.length };
});

const total = measured.reduce((sum, chunk) => sum + chunk.gzip, 0);
const rawTotal = measured.reduce((sum, chunk) => sum + chunk.raw, 0);

// Largest first: a reader who has just been told the number is over is looking
// for what to move, and the answer is almost always at the top of this list.
for (const chunk of [...measured].sort((a, b) => b.gzip - a.gzip)) {
  process.stdout.write(
    `  ${kb(chunk.gzip)} gz ${kb(chunk.raw)}  ${chunk.name}\n`
  );
}

// Everything built that no first load fetches — the routes and the panels
// behind them. Reported because a shrinking first load means nothing on its own:
// it can be paid for by splitting, or by deleting something somebody needed.
const deferred = readdirSync(join(DIST, "assets"))
  .filter((name) => name.endsWith(".js") && !eager.includes(name))
  .reduce(
    (sum, name) =>
      sum + gzipSync(readFileSync(join(DIST, "assets", name))).length,
    0
  );

const budget = BUDGET_KB * BYTES_IN_KB;

process.stdout.write(
  `\ndashboard-budget: first load ${kb(total).trim()} gz (${kb(rawTotal).trim()} raw) ` +
    `across ${eager.length} chunks, budget ${kb(budget).trim()}; ` +
    `${kb(deferred).trim()} gz more is fetched on demand\n`
);

if (total > budget) {
  process.stderr.write(
    `dashboard-budget: over budget by ${kb(total - budget).trim()} — ` +
      "split the new weight behind a route or an overlay, or raise BUDGET_KB and say why\n"
  );
  process.exitCode = OVER_BUDGET_EXIT_CODE;
}
