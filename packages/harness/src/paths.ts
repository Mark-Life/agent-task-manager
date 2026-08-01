/**
 * Where a run's files live. Pure path algebra — nothing here touches a disk.
 *
 * This is the single source of truth for the layout because three parties have
 * to agree on it and none of them can see the others: the sandbox creates the
 * directories and mounts them, the provider inside the container is pointed at
 * them through environment variables, and the orchestrator reads the transcript
 * and the event file back out afterwards. A second spelling of any of these
 * paths is a run whose transcript is never found.
 *
 * The layout is per run rather than per session on purpose. Both providers keep
 * refreshing subscription credentials in their config directory, so two
 * containers sharing one copy invalidate each other; a private copy per run
 * costs a directory and removes the whole class of failure.
 *
 * {@link runLayout} is applied twice against different roots — once to the data
 * root on the host, once to the path the run directory is mounted at inside the
 * container — so the two views cannot disagree about anything but the prefix.
 */

import { join } from "node:path";
import type { RunId, SessionProvider } from "@workspace/domain";

/** Directory under the data root holding one subdirectory per run. */
export const RUNS_SEGMENT = "runs";

/** The run's private agent home, mounted read-write into the container. */
export const AGENT_HOME_SEGMENT = "agent-home";

/** The run's normalized event stream, one JSON line per normalized event. */
export const EVENT_LOG_FILE = "events.jsonl";

/**
 * Where the run directory is mounted inside the sandbox. Only the run's own
 * directory is mounted, never the data root: a container that can see
 * `runs/` can see every other run's credentials.
 */
export const CONTAINER_RUN_DIR = "/run";

/** Each provider's own corner of the agent home. */
const AGENT_HOME_SUBDIR = {
  claude: "claude",
  codex: "codex",
} as const satisfies Record<SessionProvider, string>;

/**
 * The environment variable that relocates a provider's config directory. This
 * is the whole session-identity mechanism: without it both providers write to
 * `~/.claude` or `~/.codex`, and the transcript lands somewhere shared,
 * unattributable and full of every other project's history.
 */
export const AGENT_HOME_ENV_VAR = {
  claude: "CLAUDE_CONFIG_DIR",
  codex: "CODEX_HOME",
} as const satisfies Record<SessionProvider, string>;

/** Where each provider writes transcripts, relative to its agent home. */
const TRANSCRIPT_SUBDIR = {
  claude: "projects",
  codex: "sessions",
} as const satisfies Record<SessionProvider, string>;

/**
 * How each provider names transcript files under its transcript directory,
 * as a glob. Documentation for the reader, which scans rather than composing a
 * path: Claude nests one directory per workspace and names the file after the
 * session id, Codex nests year/month/day and names it after the rollout. Both
 * conventions belong to the vendors, so a reader that scans keeps working when
 * one of them changes the nesting.
 */
export const TRANSCRIPT_GLOB = {
  claude: "*/*.jsonl",
  codex: "*/*/*/rollout-*.jsonl",
} as const satisfies Record<SessionProvider, string>;

/** The directories and files one run owns, under whichever root is looking. */
export interface RunLayout {
  /** Private per-provider config directories live under here; mounted read-write. */
  readonly agentHomeDir: string;
  /** The normalized event stream the orchestrator ingests after the run. */
  readonly eventLogPath: string;
  /** The run's own directory — the only thing mounted into its container. */
  readonly runDir: string;
}

/** The layout under an already-resolved run directory. */
export const runLayout = (runDir: string): RunLayout => ({
  agentHomeDir: join(runDir, AGENT_HOME_SEGMENT),
  eventLogPath: join(runDir, EVENT_LOG_FILE),
  runDir,
});

/** What names one run's directory on the host. */
export interface RunDirInput {
  readonly dataRoot: string;
  readonly runId: RunId;
}

/** The run's directory on the host, under the data root. */
export const runDirOf = (input: RunDirInput) =>
  join(input.dataRoot, RUNS_SEGMENT, input.runId);

/** The layout as the host sees it. */
export const hostRunLayout = (input: RunDirInput) => runLayout(runDirOf(input));

/**
 * The layout as the container sees it. Constant, because every run is mounted
 * at the same place — the run id is in the host path and nowhere else, so a
 * prompt or a transcript cannot leak which run wrote it.
 */
export const containerRunLayout = runLayout(CONTAINER_RUN_DIR);

/**
 * What `run.agent_home_path` stores: the agent home relative to the data root,
 * so the column survives the data root moving.
 */
export const agentHomeRelativePath = (runId: RunId) =>
  join(RUNS_SEGMENT, runId, AGENT_HOME_SEGMENT);

/** One provider's config directory inside the run's agent home. */
export const agentHomeOf = (layout: RunLayout, provider: SessionProvider) =>
  join(layout.agentHomeDir, AGENT_HOME_SUBDIR[provider]);

/**
 * The environment that points a provider at an already-resolved config
 * directory. The directory is passed in rather than derived because the party
 * starting the provider was handed one — by the seeding step, or by a sandbox
 * that mounted it — and re-deriving it from a run layout is where the two
 * spellings of the same path came from.
 */
export const agentHomeEnvAt = (
  provider: SessionProvider,
  agentHomeDir: string
): Readonly<Record<string, string>> => ({
  [AGENT_HOME_ENV_VAR[provider]]: agentHomeDir,
});

/**
 * The environment a provider is started with so it writes into this run's agent
 * home. Merged over the run's other environment by the caller; it is one
 * variable, and it is the only one that must not be overridden.
 */
export const agentHomeEnv = (layout: RunLayout, provider: SessionProvider) =>
  agentHomeEnvAt(provider, agentHomeOf(layout, provider));

/** The directory a provider's transcripts land in. Scan it with {@link TRANSCRIPT_GLOB}. */
export const transcriptDirOf = (layout: RunLayout, provider: SessionProvider) =>
  join(agentHomeOf(layout, provider), TRANSCRIPT_SUBDIR[provider]);
