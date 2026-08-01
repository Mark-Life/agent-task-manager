import { $ } from "bun";

const SEPARATOR_WIDTH = 50;

const WORKSPACES = [
  "apps/web",
  "packages/api",
  "packages/env",
  "packages/ui",
] as const;

/**
 * TypeScript 7 is the native port: it ships no JS compiler API, which Next.js
 * still requires. Keep the whole monorepo on the 6.x line until Next supports it.
 */
const TYPESCRIPT_RANGE = "6";

/** Expand a shell command into one step per workspace. */
const perWorkspace = (
  label: string,
  command: (workspace: string) => ReturnType<typeof $>
) =>
  WORKSPACES.map((workspace) => ({
    command: () => command(workspace).cwd(workspace),
    critical: true,
    name: `${label}: ${workspace}`,
  }));

const steps = [
  {
    command: () =>
      $`bun add -D --exact @biomejs/biome@latest typescript@${TYPESCRIPT_RANGE} ultracite@latest`,
    critical: true,
    name: "Bump root dev tooling",
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
  ...perWorkspace(
    "Pin TypeScript",
    () => $`bun add -D typescript@${TYPESCRIPT_RANGE}`
  ),
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
