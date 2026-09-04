/**
 * Where a run's files live, and where a provider's login lives. Pure path
 * algebra — nothing here touches a disk.
 *
 * This is the single source of truth for the layout because three parties have
 * to agree on it and none of them can see the others: the sandbox creates the
 * directories and mounts them, the provider inside the container is pointed at
 * them through environment variables, and the orchestrator reads the transcript
 * and the event file back out afterwards. A second spelling of any of these
 * paths is a run whose transcript is never found.
 *
 * The run directory is per run; the agent home is emphatically not. One
 * system-owned directory per provider lives on the host, is mounted read-write
 * into every container, and is never copied — because both vendors refresh
 * their subscription token in place, and a refresh that lands in a throwaway
 * copy is thrown away with the container while the original goes stale forever.
 * The two directories therefore have different lifetimes, which is why the home
 * is not part of {@link RunLayout}.
 *
 * {@link runLayout} is applied twice against different roots — once to the data
 * root on the host, once to the path the run directory is mounted at inside the
 * container — so the two views cannot disagree about anything but the prefix.
 */

import { homedir } from "node:os";
import { join, resolve } from "node:path";
import {
  AGENTS_INSTRUCTIONS_FILE,
  type RunId,
  type SessionProvider,
} from "@workspace/domain";

/** Directory under the data root holding one subdirectory per run. */
export const RUNS_SEGMENT = "runs";

/** The run's normalized event stream, one JSON line per normalized event. */
export const EVENT_LOG_FILE = "events.jsonl";

/**
 * Where the run directory is mounted inside the sandbox. Only the run's own
 * directory is mounted, never the data root: a container that can see
 * `runs/` can see every other run's files.
 */
export const CONTAINER_RUN_DIR = "/run";

/**
 * The empty marker file that names the top of a run's instruction tree.
 *
 * Codex collects `AGENTS.md` by walking up from the working directory until it
 * finds a `project_root_markers` entry, and reads nothing above it — so this
 * name is what decides how much of the tree a Codex run is handed. Under the
 * default `[".git"]` a run standing in its checkout gets the checkout's own
 * file and none of the scopes above it. `./codex-config` points the setting
 * here; Claude needs neither the marker nor the setting, its own walk having no
 * stop until the filesystem root.
 *
 * Stated here rather than in `@workspace/sandbox`, which is what creates the
 * file: the sandbox depends on this package and not the other way round, so
 * only this direction is importable, and this file is already where parties
 * that cannot see each other agree on a path.
 */
export const ATM_ROOT_MARKER = ".atm-root";

/**
 * The whole body of a `CLAUDE.md` that defers to the `AGENTS.md` beside it.
 *
 * `@path` is Claude's own import, resolved relative to the importing file — so
 * this line works wherever the pair is written and names no absolute path a
 * container would not recognise. This repository's own `.claude/CLAUDE.md` is
 * the same one-line file, which is where the form was verified.
 */
export const CLAUDE_INSTRUCTIONS_IMPORT = `@${AGENTS_INSTRUCTIONS_FILE}\n`;

/**
 * The environment variable that relocates a provider's config directory. This
 * is the whole session-identity mechanism: without it both providers write to
 * `~/.claude` or `~/.codex`, which is the operator's own tooling and every
 * project they have ever opened.
 */
export const AGENT_HOME_ENV_VAR = {
  claude: "CLAUDE_CONFIG_DIR",
  codex: "CODEX_HOME",
  pi: "PI_CODING_AGENT_DIR",
} as const satisfies Record<SessionProvider, string>;

/**
 * The variable that names the host directory holding a provider's login.
 *
 * Deliberately `ATM_`-prefixed rather than the vendor's own name. A host
 * process that exported `CLAUDE_CONFIG_DIR` would relocate its own tooling, and
 * a variable that means "where this process keeps its config" in one file and
 * "where the containers keep theirs" in another is a variable nobody can read.
 * The container still receives the vendor name — that is {@link agentHomeEnvAt}
 * — pointing at the mount.
 */
export const AGENT_HOME_DIR_ENV_VAR = {
  claude: "ATM_AGENT_HOME_DIR_CLAUDE",
  codex: "ATM_AGENT_HOME_DIR_CODEX",
  pi: "ATM_AGENT_HOME_DIR_PI",
} as const satisfies Record<SessionProvider, string>;

/**
 * The file Pi keeps its credentials in, inside its config directory.
 *
 * Named here rather than in the Pi harness because two readers that never meet
 * want it: the login hint below tells an operator where to write a key, and
 * `scripts/harness-check.ts` looks for it. It is the only one of the three
 * vendors' credential files this package spells out, and only because the hint
 * quotes a path.
 */
export const PI_AUTH_FILE = "auth.json";

/** What each provider's system-owned home is called under the operator's home directory. */
const AGENT_HOME_DIR_NAME = {
  claude: ".claude-task-management",
  codex: ".codex-task-management",
  pi: ".pi-task-management",
} as const satisfies Record<SessionProvider, string>;

/**
 * The host directory holding one provider's login when nothing overrides it.
 *
 * Two directories rather than one root with a subdirectory per provider: they
 * are different shapes with different vendor semantics, and a shared parent
 * would only be a name for something neither vendor knows about.
 *
 * Beside the operator's own `~/.claude` and `~/.codex` rather than inside them,
 * because this one is logged into separately and every container can write it.
 */
export const defaultAgentHomeDirOf = (provider: SessionProvider) =>
  join(homedir(), AGENT_HOME_DIR_NAME[provider]);

/**
 * What each provider's login looks like on disk, as a name to test for.
 *
 * Claude keeps its tokens in `.credentials.json` on any host with no keychain,
 * which is every container — so that is the file the shared home must hold even
 * on a Mac, and `scripts/agent-home-login.ts` is what puts it there. Codex and
 * Pi both keep theirs in `auth.json`, in their own directories and in their own
 * shapes; the shared name is a coincidence of two vendors, not a shared format.
 *
 * Existence is the whole of what a caller should ask. The contents are a live
 * credential, and nothing in this system has a reason to read one.
 *
 * **Pi is the one where absence is not conclusive.** Pi also takes its key from
 * the environment — `OPENROUTER_API_KEY` and the two dozen others in its
 * provider table — so a Pi home with no `auth.json` may still run every turn it
 * is asked to. A caller that treats this as a hard gate should say which of the
 * two it is checking; see `scripts/harness-check.ts`, which reports Pi's as a
 * note and not as a failed claim.
 */
export const AGENT_HOME_CREDENTIAL_FILE = {
  claude: ".credentials.json",
  codex: "auth.json",
  pi: PI_AUTH_FILE,
} as const satisfies Record<SessionProvider, string>;

/**
 * The one-time login a missing or empty agent home is fixed by.
 *
 * A record rather than a chain of conditionals, so a fourth provider is a build
 * error here and not a run told to log into Codex.
 *
 * Pi's line names two routes because Pi has two, and the cheap one is the point
 * of running it: the interactive `/login` writes the same `auth.json` that a
 * hand-written `{"openrouter": {"type": "api_key", "key": "…"}}` does, and a
 * host that already exports `OPENROUTER_API_KEY` needs neither. What the
 * directory still has to be is *there*: Pi files every session under it, which
 * is where {@link transcriptDirOf} looks, so an absent home is a run whose
 * transcript can never be found — the same dispatch failure it is for the other
 * two, arrived at for a different reason.
 */
const AGENT_HOME_LOGIN_HINT = {
  claude: (dir: string) =>
    `run \`CLAUDE_CONFIG_DIR=${dir} claude\` once and use /login`,
  codex: (dir: string) => `run \`CODEX_HOME=${dir} codex login\` once`,
  pi: (dir: string) =>
    `run \`PI_CODING_AGENT_DIR=${dir} pi\` once and use /login, or write ${join(dir, PI_AUTH_FILE)} by hand as \`{"<provider>": {"type": "api_key", "key": "…"}}\``,
} as const satisfies Record<SessionProvider, (dir: string) => string>;

/** The one-time login a missing or empty agent home is fixed by. */
export const agentHomeLoginHint = (
  provider: SessionProvider,
  agentHomeDir: string
) => AGENT_HOME_LOGIN_HINT[provider](agentHomeDir);

/** Where each provider writes transcripts, relative to its agent home. */
const TRANSCRIPT_SUBDIR = {
  claude: "projects",
  codex: "sessions",
  pi: "sessions",
} as const satisfies Record<SessionProvider, string>;

/**
 * How each provider names transcript files under its transcript directory,
 * as a glob. Documentation for the reader, which scans rather than composing a
 * path: Claude nests one directory per workspace and names the file after the
 * session id, Codex nests year/month/day and names it after the rollout, and Pi
 * nests one directory per working directory — `--tmp-run-workspace--`, the path
 * with its separators flattened — and names the file
 * `<timestamp>_<session-id>.jsonl`. Both halves of Pi's name matter to the
 * reader: the id is in it, which is what makes the scan addressable, and the
 * timestamp is in front of it, which is why the scan cannot be a composed path.
 * All three conventions belong to the vendors, so a reader that scans keeps
 * working when one of them changes the nesting.
 */
export const TRANSCRIPT_GLOB = {
  claude: "*/*.jsonl",
  codex: "*/*/*/rollout-*.jsonl",
  pi: "*/*.jsonl",
} as const satisfies Record<SessionProvider, string>;

/** The directories and files one run owns, under whichever root is looking. */
export interface RunLayout {
  /** The normalized event stream the orchestrator ingests after the run. */
  readonly eventLogPath: string;
  /** The run's own directory — one of the two things mounted into its container. */
  readonly runDir: string;
}

/** The layout under an already-resolved run directory. */
export const runLayout = (runDir: string): RunLayout => ({
  eventLogPath: join(runDir, EVENT_LOG_FILE),
  runDir,
});

/** What names one run's directory on the host. */
export interface RunDirInput {
  readonly dataRoot: string;
  readonly runId: RunId;
}

/**
 * The directory every run's directory is a child of.
 *
 * Named separately because a sweep reads the parent and a run writes a child,
 * and the two have to agree on the spelling — this is the same reason the whole
 * file exists, applied one level up.
 */
export const runsRootOf = (dataRoot: string) => join(dataRoot, RUNS_SEGMENT);

/** The run's directory on the host, under the data root. */
export const runDirOf = (input: RunDirInput) =>
  join(runsRootOf(input.dataRoot), input.runId);

/** The layout as the host sees it. */
export const hostRunLayout = (input: RunDirInput) => runLayout(runDirOf(input));

/**
 * The layout as the container sees it. Constant, because every run is mounted
 * at the same place — the run id is in the host path and nowhere else, so a
 * prompt or a transcript cannot leak which run wrote it.
 */
export const containerRunLayout = runLayout(CONTAINER_RUN_DIR);

/**
 * The environment that points a provider at an already-resolved config
 * directory. The directory is passed in rather than derived because the party
 * starting the provider was handed one — by the sandbox that mounted it — and
 * re-deriving it from a run layout is where the two spellings of the same path
 * came from.
 *
 * The path is made absolute here, which is the one place it can be. A data root
 * is ordinarily relative — `.data` is the default — so the layout built over it
 * is relative too, and that is harmless right up to the moment it crosses into
 * a child process. The provider is started with the run's workspace as its
 * working directory, so a relative config directory resolves against the
 * workspace rather than against us: the CLI looks for the credential under the
 * checkout, finds nothing, and reports a host that has never logged in. An
 * absolute path is already its own resolution, so a container's `/run/...` is
 * untouched.
 */
export const agentHomeEnvAt = (
  provider: SessionProvider,
  agentHomeDir: string
): Readonly<Record<string, string>> => ({
  [AGENT_HOME_ENV_VAR[provider]]: resolve(agentHomeDir),
});

/**
 * The directory a provider's transcripts land in, under an already-resolved
 * agent home. Scan it with {@link TRANSCRIPT_GLOB}.
 *
 * The home is passed in rather than derived from a run, and that is the whole
 * point: every run's conversation now lands in the one shared tree, so a reader
 * that composed a per-run path would find nothing and a reader that took the
 * newest file would find a neighbour's.
 */
export const transcriptDirOf = (
  agentHomeDir: string,
  provider: SessionProvider
) => join(agentHomeDir, TRANSCRIPT_SUBDIR[provider]);
