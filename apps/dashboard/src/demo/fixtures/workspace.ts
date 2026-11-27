/**
 * Quota, the files runs kept, and the agent filesystem.
 */

import type { Artifact, ProviderUsageSnapshot } from "@workspace/api";
import { ArtifactId, RunId } from "@workspace/domain";
import { ago, ahead, DEMO_WORKSPACE, demoUuid, HOUR } from "@/demo/ids";
import { PROJECT } from "./projects";
import { SCRIPTS } from "./scripts";
import { taskIdOf } from "./tasks";

const window = (
  kind: "primary" | "secondary",
  label: string,
  used: number,
  resetsIn: number
) => ({
  kind,
  label,
  remainingPercent: 100 - used,
  resetsAt: ahead(resetsIn),
  usedPercent: used,
  windowSeconds: kind === "primary" ? 5 * 3600 : 7 * 24 * 3600,
});

export const USAGE: ProviderUsageSnapshot = {
  providers: [
    {
      attemptedAt: ago(1),
      enforced: true,
      note: null,
      pausedUntil: null,
      provider: "claude",
      readAt: ago(1),
      stale: false,
      state: "ok",
      windows: [
        window("primary", "5h", 46, 2 * HOUR + 10),
        window("secondary", "7d", 31, 3 * 24 * HOUR),
      ],
    },
    {
      attemptedAt: ago(1),
      enforced: true,
      note: null,
      pausedUntil: null,
      provider: "codex",
      readAt: ago(1),
      stale: false,
      state: "ok",
      windows: [
        window("primary", "5h", 63, 3 * HOUR + 40),
        window("secondary", "7d", 52, 4 * 24 * HOUR),
      ],
    },
  ],
  publishedAt: ago(1),
};

/** The run index each script got, in the order `./runs` built them. */
const runIdOf = (scriptKey: string) =>
  RunId.make(demoUuid("run", Object.keys(SCRIPTS).indexOf(scriptKey) + 1));

interface FileSpec {
  readonly body: string;
  readonly minutes: number;
  readonly path: string;
  readonly projectId: (typeof PROJECT)[keyof typeof PROJECT];
  readonly script: string;
  readonly taskKey: string;
}

const FILES: readonly FileSpec[] = [
  {
    body: "# Where to stay in Lisbon\n\n## 1. Príncipe Real\nQuiet streets, gardens, 10 minutes down to the river. Tram 24 and the metro at Rato.\n\n## 2. Campo de Ourique\nA neighbourhood people live in. Market, bakeries, tram 28 starts here so it is never full.\n\n## 3. Alfama\nThe view and the fado, but only with a room off the tram line. Steep, loud on Friday nights.\n\n**Avoid:** Bairro Alto for sleep.\n",
    minutes: 2 * 24 * 60 + 19,
    path: "lisbon-areas.md",
    projectId: PROJECT.trip,
    script: "areas",
    taskKey: "lisbon-areas",
  },
  {
    body: "# Alfama: 3 hotels under 180 a night\n\n1. **Casa do Miradouro** — terrace view, some street noise.\n2. **Pátio das Escadinhas** — quietest reviews, above budget in March.\n3. **Rio à Vista** — small, river view, stairs.\n",
    minutes: 25 * 60,
    path: "alfama-hotels.md",
    projectId: PROJECT.trip,
    script: "hotel",
    taskKey: "hotel",
  },
  {
    body: "# Handoff\n\nOpened #83. Containers now start on a network that only reaches the package cache and api.github.com.\n\n- `packages/sandbox/src/egress.ts`: the allowlist\n- `bun run sandbox:check --agent`: 9 claims hold\n\nNot done: IPv6 is off rather than filtered.\n",
    minutes: 3 * 60 + 9,
    path: "handoff.md",
    projectId: PROJECT.atm,
    script: "egress",
    taskKey: "egress",
  },
];

export const ARTIFACTS: readonly Artifact[] = FILES.map((file, index) => ({
  bytes: new TextEncoder().encode(file.body).length,
  contentHash: null,
  createdAt: ago(file.minutes),
  ext: "md",
  id: ArtifactId.make(demoUuid("artifact", index + 1)),
  lastRunId: runIdOf(file.script),
  modifiedAt: ago(file.minutes),
  path: file.path,
  projectId: file.projectId,
  promotedAt: null,
  scope: "task",
  sourceArtifactId: null,
  taskId: taskIdOf(file.taskKey),
  updatedAt: ago(file.minutes),
  workspaceId: DEMO_WORKSPACE,
}));

export const ARTIFACT_BODIES: ReadonlyMap<string, string> = new Map(
  ARTIFACTS.map((artifact, index) => [artifact.id, FILES[index]?.body ?? ""])
);

/** The agent filesystem: scope address, then path, then file content. */
export const SCOPE_FILES: Record<string, Record<string, string>> = {
  manager: {
    "AGENTS.md":
      "# Manager\n\nYou talk to me in Telegram and on the dashboard. Keep answers short. File work as tasks; never do it yourself.\n",
  },
  [`project:${PROJECT.atm}`]: {
    "AGENTS.md":
      "# agent-task-manager\n\nBun, Effect v4, Postgres. Run `bun run typecheck` and `bun run check` before you open a PR.\n",
    "notes/sandbox.md":
      "Containers are arm64. The package cache is shared and read-only.\n",
  },
  [`project:${PROJECT.site}`]: {
    "AGENTS.md":
      "# andrey-markin-website\n\nNext.js. Photos first, short text. Style only with the theme tokens.\n",
  },
  workspace: {
    "AGENTS.md":
      "# House rules\n\n- Work on a branch, open a PR, never push to main.\n- Say what you could not verify.\n- Short messages. No emojis.\n",
    "skills/pr-issue/SKILL.md":
      "---\nname: pr-issue\n---\n\nTitle as `area: summary`. Problem, Solution, Evidence, Risks.\n",
  },
};
