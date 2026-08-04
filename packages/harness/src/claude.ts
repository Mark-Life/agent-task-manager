/**
 * The Claude harness: the Agent SDK driven for one turn, as a stream.
 *
 * Three properties are the reason this is a `Stream` rather than an async
 * generator. The subprocess hangs off the stream's scope, so an interrupted
 * consumer takes the CLI down with it instead of orphaning it. The failure
 * channel is typed, so a caller can retry a rate limit and refuse to retry a
 * login. And the terminus is guaranteed: a stream that ends on its own always
 * ends on a `result` event, because a turn that quietly produced nothing is
 * otherwise indistinguishable from one that went fine.
 *
 * A failed turn is not a failed stream. The SDK reporting `error_max_turns` is
 * the provider answering the question it was asked, so it arrives as a `result`
 * event carrying the classification; only a throw — a dead subprocess, a
 * refused login, an aborted signal — fails the stream, and then the caller has
 * the typed error instead. Fiber interruption is neither: it is the ordinary
 * way a stop command ends a run, and it produces no event at all.
 *
 * The mapping from SDK message to normalized event lives next door in
 * `claude-events`, which is pure and testable without ever starting a process.
 */

import { delimiter, join } from "node:path";
import {
  AbortError,
  type Options,
  query,
  type Settings,
} from "@anthropic-ai/claude-agent-sdk";
import type { SessionProvider } from "@workspace/domain";
import { clipError } from "@workspace/telemetry";
import { Effect, Option, Stream } from "effect";
import { FileSystem } from "effect/FileSystem";
import {
  makeCursor,
  normalize,
  PROVIDER_ID,
  terminusOf,
} from "./claude-events";
import {
  CLAUDE_SETTING_SOURCES,
  DEFAULT_CLAUDE_EFFORT,
  DEFAULT_CLAUDE_SETTINGS,
  EFFORT_LEVELS,
  effortOf,
  mergeClaudeSettings,
  stopHookSettings,
} from "./claude-settings";
import { trimmedOrNull } from "./env";
import {
  classify,
  type HarnessError,
  Interrupted,
  keepStderrTail,
  NetworkFailed,
  ProcessFailed,
  ProviderCrashed,
  QuotaExhausted,
  RateLimited,
  Unauthenticated,
} from "./errors";
import { agentHomeEnvAt } from "./paths";
import type {
  AgentProvider,
  Choice,
  ProviderCapabilities,
  RunOptions,
} from "./provider";

/**
 * Models offered for a run. Aliases rather than pinned ids, so the choice
 * survives a version bump; a caller that wants an exact snapshot passes the
 * full id through `RunOptions.model`, which is free text.
 */
const MODELS: readonly Choice[] = [
  { id: "opus", label: "Opus" },
  { id: "sonnet", label: "Sonnet" },
  { id: "haiku", label: "Haiku" },
  { id: "fable", label: "Fable" },
];

/** Display names for the effort levels, in the SDK's own vocabulary. */
const EFFORT_LABELS = {
  high: "High",
  low: "Low",
  max: "Maximum",
  medium: "Medium",
  xhigh: "Extra high",
} as const satisfies Record<(typeof EFFORT_LEVELS)[number], string>;

const EFFORTS: readonly Choice[] = EFFORT_LEVELS.map((id) => ({
  id,
  label: EFFORT_LABELS[id],
}));

/**
 * What Claude can be relied on to do. Every flag is true, which is the reason
 * this harness is the default: it is the only one that reports a dollar cost
 * under a subscription and warns before the window closes.
 */
const CAPABILITIES: ProviderCapabilities = {
  cost: true,
  hooks: true,
  rateLimitSignal: true,
  reasoning: true,
  resume: true,
  subagents: true,
};

/**
 * Environment variables stripped from what the CLI inherits. Both switch the
 * run off the subscription and onto metered API billing, and a key left over
 * from an unrelated tool on the host is not a decision anyone made about this
 * run. A caller that genuinely wants API billing passes one back in
 * `RunOptions.env`, which is applied after this.
 */
const SUBSCRIPTION_CONFLICTS = new Set([
  "ANTHROPIC_API_KEY",
  "ANTHROPIC_AUTH_TOKEN",
]);

/**
 * Names the `claude` executable the SDK should spawn. The path is a property of
 * the image and not of this package, so the party that starts the run sets it
 * and the provider reads it — the same arrangement as the stop-hook command.
 *
 * Absence is the SDK's own resolution, which looks the CLI up through
 * `createRequire` against the file the SDK was imported from. That is right
 * wherever a real `node_modules` sits beside that file and wrong for a single
 * mounted bundle, which has none: bun then fetches the native CLI over the
 * network on every run, and with networking off the turn dies before it starts.
 */
export const CLAUDE_CLI_PATH_ENV_VAR = "ATM_CLAUDE_CLI_PATH";

/** The name the CLI is installed under, on PATH. */
const CLAUDE_CLI_FILE = "claude";

/** The configured CLI path, or null when nothing names one. */
export const claudeCliPath = (
  env: Readonly<Record<string, string | undefined>>
) => trimmedOrNull(env[CLAUDE_CLI_PATH_ENV_VAR]);

/**
 * The `claude` on a PATH, or null when that PATH has none.
 *
 * Searched rather than composed, because only the image knows where it put the
 * CLI: `atm.local/base` installs it globally with npm and proves it by running
 * `claude --version`, so PATH is the one thing the image guarantees and a
 * literal path here would be this package guessing at somebody else's layout.
 */
export const findClaudeCli = Effect.fn("Claude.findCli")(function* (
  path: string | undefined
) {
  const fs = yield* FileSystem;
  const candidates = (path ?? "")
    .split(delimiter)
    .filter((dir) => dir.length > 0)
    .map((dir) => join(dir, CLAUDE_CLI_FILE));
  const found = yield* Effect.findFirst(candidates, (candidate) =>
    fs.exists(candidate).pipe(Effect.orElseSucceed(() => false))
  );
  return Option.getOrNull(found);
});

/**
 * Points this process's Claude turns at the CLI on PATH, for a caller — the
 * container's entrypoint — that knows the image pinned one.
 *
 * A path already in the environment wins: whoever set it named a specific
 * executable, and searching PATH over the top of that would quietly run a
 * different one. A PATH with no `claude` is left alone rather than failed on,
 * which leaves the SDK's own resolution and the error it raises when that finds
 * nothing either — a truthful message about a missing CLI beats one about a
 * missing environment variable nobody was asked to set.
 */
export const useImageClaudeCli = Effect.fn("Claude.useImageCli")(function* (
  provider: SessionProvider
) {
  if (provider !== PROVIDER_ID || claudeCliPath(process.env) !== null) {
    return;
  }
  const found = yield* findClaudeCli(process.env.PATH);
  if (found === null) {
    yield* Effect.logWarning("no claude cli on PATH", {
      path: process.env.PATH,
    });
    return;
  }
  yield* Effect.sync(() => {
    process.env[CLAUDE_CLI_PATH_ENV_VAR] = found;
  });
});

/** The exit code the SDK reports in the text of its process-exit error. */
const EXIT_CODE_PATTERN = /exited with code (\d+)/;

/** The CLI's exit code, when the thrown value is the one that names it. */
const exitCodeOf = (thrown: unknown) => {
  const matched =
    thrown instanceof Error ? EXIT_CODE_PATTERN.exec(thrown.message) : null;
  const code = Number.parseInt(matched?.[1] ?? "", 10);
  return Number.isFinite(code) ? code : null;
};

/**
 * Whatever the SDK threw, as a typed failure.
 *
 * Two of the classes are deliberately not produced here. `TimedOut` names a cap
 * and prints the milliseconds of it, and this harness enforces none — a request
 * the SDK gave up waiting for is a request that never came back, which is what
 * {@link NetworkFailed} says without inventing a number. `NoTerminalEvent` is
 * an ending rather than a throw, so it arrives as an event.
 */
export const harnessErrorOf = (
  thrown: unknown,
  stderr: string
): HarnessError => {
  const detail = clipError(
    thrown instanceof Error ? thrown.message : String(thrown)
  );
  const exitCode = exitCodeOf(thrown);
  // An abort that surfaces as an error is the caller's external signal: an
  // interrupted fiber tears the stream down without one ever being read.
  if (thrown instanceof AbortError) {
    return new Interrupted({ reason: "stopped" });
  }
  switch (classify({ exitCode, stderr, thrown })) {
    case "Interrupted":
      return new Interrupted({ reason: "stopped" });
    case "NetworkFailed":
    case "TimedOut":
      return new NetworkFailed({ detail });
    case "ProcessFailed":
      return exitCode === null
        ? new ProviderCrashed({ cause: thrown, message: detail })
        : new ProcessFailed({ exitCode, stderr });
    case "QuotaExhausted":
      return new QuotaExhausted({ detail });
    case "RateLimited":
      // The SDK reports no retry-after, and a fabricated backoff is worse than
      // none because the scheduler will believe it.
      return new RateLimited({ retryAfterMs: null });
    case "Unauthenticated":
      return new Unauthenticated({ detail });
    default:
      return new ProviderCrashed({ cause: thrown, message: detail });
  }
};

/** A bounded tail of the CLI's stderr, kept for classifying what killed it. */
const makeStderrTail = () => {
  let tail = "";
  return {
    append: (chunk: string) => {
      tail = keepStderrTail(`${tail}${chunk}`);
    },
    read: () => tail,
  };
};

/**
 * The environment the CLI subprocess runs with.
 *
 * Setting this replaces the child's environment outright, so the host's is
 * spread first or the CLI loses `PATH` and `HOME` and never starts. The
 * agent-home variable is merged last and wins over everything: it is what
 * points the CLI at the mounted system-owned home, which is where the login is
 * and where a refreshed token has to land to survive the container.
 */
const envOf = (options: RunOptions) => {
  const inherited = Object.fromEntries(
    Object.entries(process.env).filter(
      ([name]) => !SUBSCRIPTION_CONFLICTS.has(name)
    )
  );
  return {
    ...inherited,
    ...options.env,
    ...agentHomeEnvAt(PROVIDER_ID, options.agentHomeDir),
  };
};

/** What one invocation needs beyond the caller's own options. */
interface QueryInput {
  readonly abortController: AbortController;
  readonly onStderr: (data: string) => void;
  readonly options: RunOptions;
  readonly settings: Settings;
}

/**
 * The SDK parameters for one turn. Pure, so what a run is actually asked to do
 * can be asserted without starting one.
 *
 * Permissions are bypassed because the container is the boundary: there is no
 * operator to prompt, and a worker that stops to ask has burned its turn.
 * `settingSources` stays explicit rather than defaulted so the repository's
 * `CLAUDE.md` is loaded on purpose and not by accident of an SDK default.
 *
 * The stop hook and the CLI path are read off the environment here rather than
 * baked into a constant, for the same reason: both are paths inside whichever
 * image is running, so they are known at run time and never at import time. A
 * CLI nobody named is left out of the options entirely, which is what keeps the
 * SDK's own resolution — correct wherever this runs with its `node_modules`.
 */
export const buildQuery = ({
  abortController,
  onStderr,
  options,
  settings,
}: QueryInput) => {
  const cliPath = claudeCliPath(process.env);
  const sdkOptions: Options = {
    abortController,
    allowDangerouslySkipPermissions: true,
    cwd: options.workspaceDir,
    effort: effortOf(options.effort) ?? DEFAULT_CLAUDE_EFFORT,
    env: envOf(options),
    permissionMode: "bypassPermissions",
    settingSources: [...CLAUDE_SETTING_SOURCES],
    settings: mergeClaudeSettings(settings, stopHookSettings(process.env)),
    stderr: onStderr,
    systemPrompt: { preset: "claude_code", type: "preset" },
    // Given here rather than written into the config directory: that directory
    // is shared by every run on the host, and a turn's own servers carry a
    // bearer token that has no business outliving it.
    ...(options.mcpServers === null
      ? {}
      : { mcpServers: options.mcpServers as Options["mcpServers"] }),
    ...(cliPath === null ? {} : { pathToClaudeCodeExecutable: cliPath }),
    ...(options.model === null ? {} : { model: options.model }),
    ...(options.resumeSessionId === null
      ? {}
      : { resume: options.resumeSessionId }),
  };
  return { options: sdkOptions, prompt: options.prompt };
};

/**
 * One turn, as a stream.
 *
 * The abort controller hangs off the stream's scope, so an interrupted consumer
 * takes the CLI subprocess down with it — the SDK's own iterator cleanup runs
 * too, but only the controller reaches a child that has stopped reading. The
 * external signal is forwarded rather than replaced, because it belongs to
 * something wider than this fiber and may outlive the turn.
 */
const claudeStream = (options: RunOptions, settings: Settings) =>
  Stream.unwrap(
    Effect.gen(function* () {
      const abortController = new AbortController();
      const stderr = makeStderrTail();
      const cursor = makeCursor();
      yield* Effect.addFinalizer(() =>
        Effect.sync(() => abortController.abort())
      );
      const external = options.signal;
      if (external !== null) {
        const forward = () => abortController.abort();
        external.addEventListener("abort", forward, { once: true });
        yield* Effect.addFinalizer(() =>
          Effect.sync(() => external.removeEventListener("abort", forward))
        );
      }
      const messages = query(
        buildQuery({
          abortController,
          onStderr: stderr.append,
          options,
          settings,
        })
      );
      return Stream.fromAsyncIterable(messages, (thrown) =>
        harnessErrorOf(thrown, stderr.read())
      ).pipe(
        Stream.flatMap((message) =>
          Stream.fromArray(normalize(cursor, message))
        ),
        Stream.concat(
          Stream.suspend(() => Stream.fromArray(terminusOf(cursor)))
        )
      );
    })
  ).pipe(
    Stream.withSpan("claude.run", {
      attributes: {
        model: options.model,
        provider: PROVIDER_ID,
        runId: options.runId,
        taskId: options.taskId,
      },
    })
  );

/**
 * The Claude harness over a settings layer of the caller's choosing. The
 * default layer is {@link DEFAULT_CLAUDE_SETTINGS}; an operator override is
 * merged onto it by the caller, because only the caller can decide whether an
 * unreadable override should stop the run.
 */
export const makeClaudeProvider = (
  settings: Settings = DEFAULT_CLAUDE_SETTINGS
): AgentProvider => ({
  capabilities: CAPABILITIES,
  defaultEffort: DEFAULT_CLAUDE_EFFORT,
  displayName: "Claude Code",
  efforts: EFFORTS,
  id: PROVIDER_ID,
  models: MODELS,
  run: (options) => claudeStream(options, settings),
});

/** The harness as the registry holds it, under the hardened defaults. */
export const claudeProvider = makeClaudeProvider();
