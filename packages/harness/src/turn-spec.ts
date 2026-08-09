/**
 * The contract that crosses the host/container boundary: what one turn is, and
 * what the container says back.
 *
 * A turn used to be a function call — the orchestrator held the options and the
 * provider ran in the same process. Once the provider runs inside a container
 * the options have to travel, and this file is the whole of how. The
 * orchestrator writes a {@link TurnSpec} into the run directory before the
 * container starts; the entrypoint reads it out of the same directory through
 * the mount; the entrypoint writes a {@link TurnResult} back into it before it
 * exits, and the host reads that after the container is gone.
 *
 * **The prompt travels in the file and nowhere else.** Not in an environment
 * variable and not on an event. `docker inspect` prints a container's whole
 * environment to anyone who can reach the daemon, `ps` prints an argv to every
 * process on the host, and a prompt carries a task's brief and its entire
 * message thread. A file on a mount the container already has is read by the
 * container and by nothing else.
 *
 * **Both sides spell the paths with the same function.** {@link turnSpecPathOf}
 * and {@link turnResultPathOf} take a {@link RunLayout}, exactly as
 * `messageMarkerPathOf` does, so the host applies them to the run's directory
 * under the data root and the container applies them to `containerRunLayout` —
 * the same algebra over two roots. A path written twice is a spec the container
 * never finds.
 *
 * **The result is the container's last word.** The event file already carries
 * everything the turn said, but three facts are only knowable to the process
 * that ran it and are gone the moment the container is removed: which provider
 * session the next turn resumes, how this turn ended, and why the process
 * exited. A spec that would not even decode produces no events at all, and the
 * result file is the only place that failure can be reported from.
 */

import { join } from "node:path";
import {
  AgentSessionId,
  RunId,
  SessionProvider,
  TaskId,
  WorkspaceId,
} from "@workspace/domain";
import { Schema } from "effect";
import { HarnessErrorClass, TurnOutcome } from "./errors";
import type { RunLayout } from "./paths";

/** The spec file, in the run directory beside the event log. */
export const TURN_SPEC_FILE = "turn-spec.json";

/** The result file, written by the container into the same directory. */
export const TURN_RESULT_FILE = "turn-result.json";

/**
 * The spec for a run, under whichever root is looking. It sits in the run
 * directory rather than in the agent home for the same reason the message
 * marker does: the agent home belongs to a vendor that rewrites it, and the run
 * directory is ours.
 */
export const turnSpecPathOf = (layout: RunLayout) =>
  join(layout.runDir, TURN_SPEC_FILE);

/** The result for a run, under whichever root is looking. */
export const turnResultPathOf = (layout: RunLayout) =>
  join(layout.runDir, TURN_RESULT_FILE);

/**
 * MCP servers the host wants this turn's provider to have, beyond the ones the
 * container configures for itself.
 *
 * A file on the run mount rather than an environment variable, for the reason
 * the spec is one: a server entry carries the bearer token it authenticates
 * with, and `docker inspect` prints an environment to anyone who can reach the
 * daemon. It is a separate file from the spec because it is written and deleted
 * around a single container's lifetime while the spec is the record of the
 * work, and because absence is an ordinary case — a turn with no extra servers
 * simply has no file.
 *
 * Its content is `{ "mcpServers": { … } }`, the same shape the provider's own
 * configuration uses, so the entrypoint merges rather than translates.
 */
export const MCP_SERVERS_FILE = "mcp-servers.json";

/** The extra-servers file, under whichever root is looking. */
export const mcpServersPathOf = (layout: RunLayout) =>
  join(layout.runDir, MCP_SERVERS_FILE);

/**
 * Where the bundled entrypoint is mounted inside the container.
 *
 * Under `/opt` rather than `/usr/local/bin`, because it is not part of the
 * image: the image carries bun, node, git and the agent CLIs — tooling that
 * moves on a weekly rebuild — while the entrypoint is this repository's own
 * code and changes every commit. Baking it in would mean an image build per
 * commit, so it is bundled on the host and bind-mounted read-only, and `/opt`
 * is where a thing that arrived from outside the image belongs.
 */
export const CONTAINER_ENTRYPOINT_PATH = "/opt/atm/turn.js";

/**
 * The interpreter the bundle is run with inside the container. The bundle is
 * JavaScript for bun rather than a compiled executable, and the image pins the
 * same bun version this repository's `packageManager` does — see
 * `scripts/build-entrypoint.ts` for why that beats `--compile`.
 */
export const CONTAINER_ENTRYPOINT_COMMAND = "bun";

/**
 * Selects the entrypoint's stop-hook mode. One bundle serves both roles because
 * the mount set carries exactly one file: the turn is what the container runs,
 * and the hook is a second process the provider spawns per attempted ending.
 */
export const STOP_HOOK_FLAG = "--stop-hook";

/** Names the spec on the command line, for a container started by hand. */
export const TURN_SPEC_FLAG = "--spec";

/** Names the spec in the environment, where a flag is awkward to pass. */
export const TURN_SPEC_ENV_VAR = "ATM_TURN_SPEC";

/**
 * The argv a container is started with. Exported as one function so the
 * orchestrator composing a {@link SandboxSpec} and the script producing the
 * bundle cannot disagree about how the file is invoked.
 */
export const containerEntrypointArgs = (): readonly string[] => [
  CONTAINER_ENTRYPOINT_PATH,
];

/**
 * The stop-hook command registered with whichever provider is running, as a
 * shell command line — which is the shape both harnesses take. The same bundle
 * at the same path, in its other mode.
 */
export const containerStopHookCommand = () =>
  `${CONTAINER_ENTRYPOINT_COMMAND} ${CONTAINER_ENTRYPOINT_PATH} ${STOP_HOOK_FLAG}`;

/** Directory under the data root holding the bundled entrypoint. */
export const ENTRYPOINT_SEGMENT = "bin";

/** The bundle's file name, on the host and inside the container alike. */
export const ENTRYPOINT_BUNDLE_FILE = "turn.js";

/**
 * The bundle on the host, under the data root. The build script writes exactly
 * here and the orchestrator mounts exactly here; a second spelling is a
 * container that starts with no entrypoint and dies on its first instruction.
 */
export const entrypointBundlePathOf = (dataRoot: string) =>
  join(dataRoot, ENTRYPOINT_SEGMENT, ENTRYPOINT_BUNDLE_FILE);

/**
 * The service name the container's wide-event ledger is written under, so its
 * `atm.turn` rows land at `<EVENT_LOG_DIR>/turn.jsonl` — inside the run mount,
 * and therefore on the host — and the loop knows which file to read.
 */
export const TURN_LEDGER_SERVICE = "turn";

/**
 * The ids this turn joins on, decoded rather than trusted. They are also in the
 * container's environment, which is what `readTurnIdentity` reads; carrying
 * them here as well makes the spec authoritative for a container started by
 * hand, and makes the file a complete description of the work.
 */
export const TurnSpecIdentity = Schema.Struct({
  runId: RunId,
  /** Null on the first run of a session, before the provider has named one. */
  sessionId: Schema.NullOr(AgentSessionId),
  /**
   * Null for a turn that is about no task — the manager agent answering a chat
   * message. Every dispatched worker turn has one, so a null here is what tells
   * the two apart on the `atm.turn` row both write.
   */
  taskId: Schema.NullOr(TaskId),
  /** W3C `traceparent` of the host's span, so the turn's spans hang under it. */
  traceparent: Schema.NullOr(Schema.String),
  workspaceId: WorkspaceId,
});

export interface TurnSpecIdentity
  extends Schema.Schema.Type<typeof TurnSpecIdentity> {}

/**
 * Everything one turn needs to run. Every field is required and explicitly
 * nullable where it can be absent, for the same reason `RunOptions` is: an
 * omitted key is how a resume silently becomes a fresh session.
 *
 * The three directories are the container's own view — `/run/agent-home/...`,
 * `/workspace` — because the party that reads them is inside it. The host's
 * spelling of the same directories never crosses.
 */
export const TurnSpec = Schema.Struct({
  /** The provider's config directory for this run, as the container sees it. */
  agentHomeDir: Schema.String,
  /** Reasoning effort, or null for the provider's own default. */
  effort: Schema.NullOr(Schema.String),
  /** Where the normalized event stream is appended, one JSON line per event. */
  eventLogPath: Schema.String,
  identity: TurnSpecIdentity,
  /** Model id, or null for the provider's own default. */
  model: Schema.NullOr(Schema.String),
  /** The brief and its thread. In this file and never in an environment variable. */
  prompt: Schema.String,
  provider: SessionProvider,
  /** The provider's own session id to continue, or null to start fresh. */
  resumeSessionId: Schema.NullOr(Schema.String),
  /**
   * The turn's own cap, or null for none.
   *
   * Set it below the container's cap. Both exist and they end differently: the
   * container's cap is a kill, which leaves no result file and a run the host
   * has to infer from silence, while this one is a `Harness.TimedOut` that
   * still writes its events, its row and its last word.
   */
  timeoutMs: Schema.NullOr(Schema.Natural),
  /** The checkout the agent works in, as the container sees it. */
  workspaceDir: Schema.String,
});

export interface TurnSpec extends Schema.Schema.Type<typeof TurnSpec> {}

/**
 * Why the entrypoint process ended.
 *
 * Finer than the turn's own outcome on purpose: `spec_unreadable` and `crashed`
 * are failures of the container's own plumbing, and folding them into the
 * turn's `errored` would make a mis-written spec look like a model that failed.
 * The rest map onto a terminus the event stream already carries.
 */
export const TURN_EXIT_REASONS = [
  "completed",
  "turn_failed",
  "no_terminus",
  "interrupted",
  "spec_unreadable",
  "crashed",
] as const;

/** How the entrypoint ended, as the host reads it off the exit code. */
export const TurnExitReason = Schema.Literals(TURN_EXIT_REASONS);
export type TurnExitReason = typeof TurnExitReason.Type;

/**
 * The process exit code each reason leaves.
 *
 * Small numbers, deliberately: docker spends 125, 126 and 127 on its own
 * failures — the daemon refused, the entrypoint was not executable, the
 * entrypoint was not found — and 128+n on a signal, so a code from this table
 * can never be confused with the daemon's account of a container that never
 * ran. The result file is the fuller answer; the code is what a caller reading
 * only `SandboxResult.exitCode` still gets.
 */
export const TURN_EXIT_CODE = {
  completed: 0,
  crashed: 4,
  interrupted: 5,
  no_terminus: 2,
  spec_unreadable: 3,
  turn_failed: 1,
} as const satisfies Record<TurnExitReason, number>;

/** The exit code for a reason. The only place the mapping is applied. */
export const exitCodeOf = (reason: TurnExitReason) => TURN_EXIT_CODE[reason];

/**
 * What the container leaves behind for the host to read after teardown.
 *
 * Measurements and classifications only — the same rule the wide event follows.
 * The assistant's final message is on the terminus in the event file, which the
 * host ingests anyway; repeating it here would put model text in a second place
 * with its own retention.
 */
export const TurnResult = Schema.Struct({
  /** The classification behind a non-clean ending, or null. */
  errorClass: Schema.NullOr(HarnessErrorClass),
  /** Already sanitized and clipped by the harness's own describer. */
  errorMessage: Schema.NullOr(Schema.String),
  /** How many normalized events the stream produced. Zero tells a dead container from a quiet one. */
  eventsSeen: Schema.Natural,
  exitReason: TurnExitReason,
  /** When the container stopped, by the container's clock. */
  finishedAt: Schema.DateTimeUtcFromString,
  /** The terminus, or null where the stream produced none. */
  outcome: Schema.NullOr(TurnOutcome),
  /** What the next turn resumes. Null before the provider named one. */
  providerSessionId: Schema.NullOr(Schema.String),
});

export interface TurnResult extends Schema.Schema.Type<typeof TurnResult> {}
