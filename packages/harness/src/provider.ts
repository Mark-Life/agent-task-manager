/**
 * What a harness is: something that turns a prompt and a workspace into a
 * stream of normalized events. Declarations only — the Claude and Codex
 * implementations live beside this file and everything above it depends on this
 * shape rather than on either of them.
 *
 * The run contract is a `Stream`, not an async generator. A generator has no
 * failure type, no interruption story, and no way to be composed with a timeout
 * or a retry without a wrapper that reinvents both; a stream carries
 * {@link HarnessError} in its type and tears the provider's subprocess down when
 * the consuming fiber is interrupted, which is exactly what a stop command
 * needs to do.
 *
 * Capabilities are flags rather than optional methods because the caller's
 * question is "will this run report a cost", asked before the run — an absent
 * method only answers it afterwards.
 */

import {
  type RunId,
  SESSION_PROVIDERS,
  type SessionProvider,
  type TaskId,
} from "@workspace/domain";
import type { Telemetry } from "@workspace/telemetry";
import { Context, type Stream } from "effect";
import type { HarnessError } from "./errors";
import type { AgentEvent } from "./events";
import type { ClaudeMcpServers } from "./mcp-servers";

/**
 * What a provider can be relied on to do. Every flag names something a caller
 * decides on before dispatching: whether to show a cost, whether to bother
 * polling a quota signal, whether resuming a session is possible at all.
 */
export interface ProviderCapabilities {
  /** Reports a dollar cost. False under a subscription that bills no per-run amount. */
  readonly cost: boolean;
  /** Runs the stop hook, so a turn can be refused an ending. */
  readonly hooks: boolean;
  /** Emits a rate-limit reading before it starts refusing, not only after. */
  readonly rateLimitSignal: boolean;
  /** Emits reasoning events, even if only as a measurement. */
  readonly reasoning: boolean;
  /** Can continue an earlier conversation from its own session id. */
  readonly resume: boolean;
  /** Can delegate to subagents, so a turn's fan-out is worth counting. */
  readonly subagents: boolean;
}

/** A selectable model or reasoning-effort level. */
export interface Choice {
  readonly id: string;
  readonly label: string;
}

/**
 * One provider invocation. Every field is required and explicitly nullable, so
 * a caller that has nothing to say about a setting has to say so — an omitted
 * key is how a resume silently becomes a fresh session.
 */
export interface RunOptions {
  /**
   * The provider's config directory, as the process starting the provider sees
   * it — the mount point the sandbox bound the system-owned home at, handed on
   * without arithmetic. The provider points its agent-home variable straight at
   * this, so a caller that composes a path of its own gets an empty directory
   * and a run with no login.
   */
  readonly agentHomeDir: string;
  /** Reasoning effort, or null for the provider's own default. */
  readonly effort: string | null;
  /**
   * Environment handed to the provider, on top of whatever the sandbox already
   * set. The agent-home variable is merged in by the provider itself and wins
   * over anything here.
   */
  readonly env: Readonly<Record<string, string>>;
  /**
   * MCP servers this turn is given, in the shape the Claude SDK reads, or null
   * for a turn with none.
   *
   * Passed as an option rather than merged into a file in the config directory,
   * and that is load-bearing now that the directory is shared by every run on
   * the host: a read-modify-write of `<agentHome>/.claude.json` is a lost-update
   * race between concurrent containers *and* a permanent write of one turn's
   * bearer token into the operator's own login config.
   *
   * Read by Claude alone. Codex's config renderer can express a server's string
   * fields and nothing else, so an `args` array would be silently dropped and
   * the server would launch with nothing to run.
   */
  readonly mcpServers: ClaudeMcpServers | null;
  /** Model id, or null for the provider's own default. */
  readonly model: string | null;
  readonly prompt: string;
  /** The provider's own session id to continue, or null to start fresh. */
  readonly resumeSessionId: string | null;
  /** Correlation only: stamped on this turn's wide event so it joins the run row. */
  readonly runId: RunId | null;
  /**
   * An external cancellation source the caller already owns — a container being
   * torn down, a shared controller across several turns. Interrupting the fiber
   * consuming the stream is the ordinary way to stop a turn and needs nothing
   * here; this is for the cases where the thing being cancelled is bigger than
   * the fiber.
   */
  readonly signal: AbortSignal | null;
  /** Correlation only, as {@link RunOptions.runId}. */
  readonly taskId: TaskId | null;
  /** Working directory the agent operates in: the run's checkout, never the host repo. */
  readonly workspaceDir: string;
}

/**
 * One harness. `run` opens the provider, streams its normalized events, and
 * fails with a typed {@link HarnessError}; the terminus is the last event on a
 * successful stream, and a stream that ends without one is the caller's
 * `no_terminal_event`.
 *
 * `Telemetry` is in the requirement because a turn leaves a row: the registry
 * wraps every provider's stream in the wide event before handing it out, and the
 * requirement is what stops a caller running one without an emitter present. An
 * implementation that needs nothing itself still satisfies this — a stream
 * requiring `never` is a stream requiring anything.
 */
export interface AgentProvider {
  readonly capabilities: ProviderCapabilities;
  /** The effort level used when the caller selects none. Null where the provider has no such setting. */
  readonly defaultEffort: string | null;
  readonly displayName: string;
  readonly efforts: readonly Choice[];
  readonly id: SessionProvider;
  readonly models: readonly Choice[];
  readonly run: (
    options: RunOptions
  ) => Stream.Stream<AgentEvent, HarnessError, Telemetry>;
}

/**
 * Every provider, one per literal in the domain's union. A total record rather
 * than a lookup that can miss: the set of providers is closed and known at
 * compile time, so a missing implementation should fail the build and not a
 * dispatch at three in the morning.
 */
export type ProviderTable = { readonly [P in SessionProvider]: AgentProvider };

/** Finds the harness for a provider. Lookup cannot fail, by construction. */
export interface ProviderRegistryInterface {
  readonly get: (provider: SessionProvider) => AgentProvider;
  /** Every provider, in the domain's declared order. */
  readonly list: readonly AgentProvider[];
}

/** Builds a registry over a complete table. Pure. */
export const makeProviderRegistry = (
  table: ProviderTable
): ProviderRegistryInterface => ({
  get: (provider) => table[provider],
  list: SESSION_PROVIDERS.map((provider) => table[provider]),
});

/**
 * The registry as a service, so a caller that only knows a task's
 * `SessionProvider` can reach the harness without importing either
 * implementation — which is what keeps this package's dependency arrow pointing
 * one way.
 */
export class ProviderRegistry extends Context.Service<
  ProviderRegistry,
  ProviderRegistryInterface
>()("@workspace/harness/ProviderRegistry") {}
