import { existsSync, readdirSync, readFileSync } from "node:fs";
import { $ } from "bun";

const SEPARATOR_WIDTH = 50;

/**
 * Every workspace, read from the root `package.json` rather than listed here.
 *
 * A hand-maintained list is a list that goes stale: this one sat at the four
 * workspaces the template shipped with long after the repo had grown to
 * nineteen, so `bun update --latest` ran in a fifth of the tree and the rest
 * quietly kept whatever it had. Expanding the same globs bun installs from
 * means the two can no longer disagree.
 */
const workspaces = (() => {
  const root = JSON.parse(readFileSync("package.json", "utf8")) as {
    workspaces: { packages: readonly string[] };
  };

  return root.workspaces.packages
    .flatMap((pattern) => {
      if (!pattern.endsWith("/*")) {
        return [pattern];
      }
      const parent = pattern.slice(0, -2);
      return readdirSync(parent, { withFileTypes: true })
        .filter((entry) => entry.isDirectory())
        .map((entry) => `${parent}/${entry.name}`);
    })
    .filter((workspace) => existsSync(`${workspace}/package.json`))
    .sort();
})();

/**
 * TypeScript 7 is the native port. It ships no JS compiler API, so Next.js
 * shells out to the project-local `tsc` instead (`experimental.useTypeScriptCli`,
 * on by default since Next 16.3). Keep Next at >=16.3 for as long as this stays
 * on 7.x, or `next build` decides TypeScript is missing and tries to install it
 * mid-build.
 *
 * Bumping this major is a breaking change, not a version bump: re-read the
 * release notes for removed compiler options before changing it, and check that
 * `@effect/tsgo` has a release built against the new major — it embeds a pinned
 * TypeScript-Go and has to be upgraded in step.
 */
const TYPESCRIPT_MAJOR = "7";

/**
 * `bun add --exact` records the spec it was handed, so a bare major would pin
 * the literal `"7"` and quietly break the exact-pin convention. Resolve it first.
 */
const typescriptVersion = (
  await $`bun info typescript@${TYPESCRIPT_MAJOR} version`.text()
).trim();

/** Expand a shell command into one step per workspace. */
const perWorkspace = (
  label: string,
  command: (workspace: string) => ReturnType<typeof $>
) =>
  workspaces.map((workspace) => ({
    command: () => command(workspace).cwd(workspace),
    critical: true,
    name: `${label}: ${workspace}`,
  }));

const steps = [
  {
    command: () =>
      $`bun add -D --exact @biomejs/biome@latest typescript@${typescriptVersion} ultracite@latest @effect/tsgo@latest`,
    critical: true,
    name: `Bump root dev tooling (TypeScript ${typescriptVersion})`,
  },
  {
    command: () => $`bun update --latest`,
    critical: true,
    name: "Bump root dependencies",
  },
  ...perWorkspace("Bump dependencies", () => $`bun update --latest`),
  {
    command: () => $`bunx @next/codemod@latest upgrade`.cwd("apps/web"),
    critical: true,
    name: "Next.js Upgrade",
  },
  {
    command: () =>
      $`bunx shadcn@latest add --all --overwrite`.cwd("packages/ui"),
    critical: true,
    name: "shadcn/ui Components",
  },
  // No per-workspace `typescript` pin. TypeScript is pinned once, in the root
  // `package.json`, and re-adding it to each workspace would give the repo
  // nineteen versions to keep in step instead of one. `bun install` also runs
  // `prepare`, which is what re-applies `effect-tsgo patch` to the freshly
  // resolved compiler — without it the Effect diagnostics silently stop.
  {
    command: () => $`bun install`,
    critical: true,
    name: "Install",
  },
  {
    command: () => $`bun run fix`,
    critical: false,
    name: "Ultracite Fix",
  },
  {
    command: () => $`bun run typecheck`,
    critical: false,
    name: "Type Check",
  },
  {
    command: () => $`bun run build`,
    critical: false,
    name: "Build",
  },
] as const;

let failed = false;

for (const step of steps) {
  console.log(`\n${"=".repeat(SEPARATOR_WIDTH)}`);
  console.log(`>> ${step.name}`);
  console.log("=".repeat(SEPARATOR_WIDTH));

  // biome-ignore lint/performance/noAwaitInLoops: each step mutates the repo and must finish before the next starts
  const result = await step.command().nothrow();

  if (result.exitCode === 0) {
    console.log(`\n✓ ${step.name} completed`);
  } else {
    console.error(`\n!! ${step.name} failed (exit code ${result.exitCode})`);

    if (step.critical) {
      console.error("Critical step failed, aborting.");
      process.exit(1);
    }

    failed = true;
    console.warn("Non-critical failure, continuing...");
  }
}

if (failed) {
  console.warn("\nUpgrade completed with warnings.");
  process.exit(1);
}

console.log("\nUpgrade completed successfully.");
