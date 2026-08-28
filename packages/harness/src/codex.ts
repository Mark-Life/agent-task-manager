/**
 * The Codex harness: one `codex exec` invocation, its JSONL stdout torn down
 * with the fiber that consumes it, and the typed failure a turn that never
 * finished comes back as.
 *
 * Codex ships a TypeScript SDK, and this file deliberately does not use it. The
 * SDK is a thin wrapper that spawns the same binary with the same arguments and
 * hands back an async generator — it adds a second place for the argument list
 * to be wrong, and it takes away the two things this system needs most: the
 * child's stderr, which is where an unauthenticated or crashed run says what
 * happened, and a teardown tied to a scope rather than to an `AbortSignal` the
 * caller has to remember to fire. Spawning it directly costs an argument list
 * and buys a subprocess that dies with the fiber consuming it.
 *
 * Everything that reads a line lives in `./codex-events`, which is pure. What
 * is left here is the process, and the one judgement the process owns: on a
 * failed turn Codex runs no stop hook at all, so nothing downstream would
 * otherwise notice the turn ended badly. A stream that stops without
 * `turn.completed` fails with a typed error rather than completing quietly.
 *
 * TODO: Codex's refresh token is single-use and it rotates `auth.json` in place
 * on every refresh. Two containers that start against the same `CODEX_HOME`
 * both present the token they read at startup; the first refresh consumes it
 * and the second gets a token the server has already retired, so that run dies
 * `Unauthenticated` and — because the loser writes its own failure back — the
 * shared login can be left needing an interactive `codex login`. Claude has no
 * such problem: its credential writes take a cross-process advisory lock at
 * `<configDir>/.storage-write`, which is what makes one shared home safe there.
 *
 * Fixing it means one of: serializing Codex turns behind a host-side lock on
 * the home; a broker on the host that refreshes once and hands out access
 * tokens; or a home per concurrent Codex slot with the refresh copied back
 * under a lock. All three are real work, none is on the path for v1, and Claude
 * is the provider for chats — so this is written down rather than fixed.
 */

import { resolve } from "node:path";
import * as BunFileSystem from "@effect/platform-bun/BunFileSystem";
import { Clock, Effect, Layer, Ref, Result, Stream } from "effect";
import * as ChildProcess from "effect/unstable/process/ChildProcess";
import { ChildProcessSpawner } from "effect/unstable/process/ChildProcessSpawner";
import {
  HOOK_TRUST_FLAG,
  initialCodexTurnState,
  PROVIDER_ID,
  stepCodexLine,
} from "./codex-events";
import { CODEX_HOOKS_FILE, writeCodexHooks } from "./codex-hooks";
import {
  classify,
  type HarnessError,
  Interrupted,
  keepStderrTail,
  NetworkFailed,
  NoTerminalEvent,
  ProcessFailed,
  ProviderCrashed,
  QuotaExhausted,
  RateLimited,
  Unauthenticated,
} from "./errors";
import { agentHomeEnvAt } from "./paths";
import type { AgentProvider, RunOptions } from "./provider";
import { abortAsFailure, crashed, spawnerLayer } from "./subprocess";

/** The binary, resolved on `PATH` inside whatever sandbox the run got. */
const CODEX_COMMAND = "codex";

/**
 * Flags every headless invocation carries.
 *
 * `--dangerously-bypass-approvals-and-sandbox` is the posture: the container is
 * the sandbox, and an approval prompt in a headless run is a turn that hangs
 * until it is killed.
 *
 * {@link HOOK_TRUST_FLAG} is the one that is easy to lose. Codex only runs a
 * hook whose source it has already recorded as trusted, and trust is recorded
 * interactively — a per-run `CODEX_HOME` never has it. Without this flag the
 * hooks are silently skipped: no error, no non-zero exit, just a turn that ends
 * when the model wants it to. The stop hook is what forces a second turn out of
 * a run that posted no message, so dropping this flag disables that check
 * everywhere at once and looks like the model simply behaving well. The flag on
 * its own registers nothing: the definition it trusts is the
 * {@link CODEX_HOOKS_FILE} written into this run's `CODEX_HOME` below, and the
 * two only work together.
 *
 * `--skip-git-repo-check` is there because a workspace is not always a checkout.
 */
const HEADLESS_FLAGS = [
  "--dangerously-bypass-approvals-and-sandbox",
  HOOK_TRUST_FLAG,
  "--skip-git-repo-check",
] as const;

/** Emits the thread/item JSONL protocol `./codex-events` parses, one per line. */
const JSON_FLAG = "--json";

/**
 * The prompt argument that means "read it from stdin". Used on every
 * invocation: a brief plus its message thread outgrows what an argument list
 * will carry, and an argument list is also world-readable in the process table.
 */
const STDIN_PROMPT = "-";

/** Reasoning effort has no flag of its own; it is a config override. */
const EFFORT_CONFIG_KEY = "model_reasoning_effort";

/**
 * The models this harness offers. Codex's own default is used when the caller
 * selects none, so there is no sentinel entry: a null model means the provider
 * decides.
 */
const CODEX_MODELS = [
  { id: "gpt-5.6-sol", label: "Sol (flagship)" },
  { id: "gpt-5.6-terra", label: "Terra (balanced)" },
  { id: "gpt-5.6-luna", label: "Luna (fast)" },
] as const;

/** Reasoning effort levels, as the CLI accepts them. */
const CODEX_EFFORTS = [
  { id: "minimal", label: "Minimal" },
  { id: "low", label: "Low" },
  { id: "medium", label: "Medium" },
  { id: "high", label: "High" },
  { id: "xhigh", label: "Extra high" },
] as const;

/** What Codex uses when the caller names no effort. */
const CODEX_DEFAULT_EFFORT = "medium";

/**
 * The argument list for one invocation.
 *
 * Order matters twice. The flags precede `resume`, because `resume` is a
 * subcommand and everything after it belongs to the subcommand. And the prompt
 * is always the last positional and always `-`, so it travels on stdin.
 *
 * The workspace is made absolute because the child is already started in it: a
 * relative `--cd` would be resolved a second time, against the directory it
 * names, and Codex would exit on a directory that does not exist. A data root
 * is relative by default, so this is the ordinary case rather than the odd one.
 */
export const codexArgs = (options: RunOptions): readonly string[] => [
  "exec",
  JSON_FLAG,
  ...HEADLESS_FLAGS,
  "--cd",
  resolve(options.workspaceDir),
  ...(options.model === null ? [] : ["--model", options.model]),
  ...(options.effort === null
    ? []
    : ["--config", `${EFFORT_CONFIG_KEY}="${options.effort}"`]),
  ...(options.resumeSessionId === null
    ? []
    : ["resume", options.resumeSessionId]),
  STDIN_PROMPT,
];

/**
 * The environment for one invocation. `CODEX_HOME` is merged last because it is
 * what points the CLI at the mounted system-owned home — where the login is,
 * and where a refreshed one has to land to survive the container.
 *
 * `CLAUDECODE` is unset rather than passed through: Codex changes its behaviour
 * when it thinks it is nested inside another agent, and a host that happens to
 * be running one would otherwise leak that into every child.
 */
export const codexEnv = (
  options: RunOptions
): Readonly<Record<string, string | undefined>> => ({
  ...options.env,
  ...agentHomeEnvAt(PROVIDER_ID, options.agentHomeDir),
  CLAUDECODE: undefined,
});

/** What a finished invocation knows about why it produced no terminus. */
interface TurnFailure {
  readonly eventsSeen: number;
  readonly exitCode: number | null;
  readonly stderr: string;
  readonly thrown: unknown;
}

/**
 * Names the failure behind a turn that produced no terminus.
 *
 * The classification is the shared one, so Codex and Claude read the same
 * stderr the same way. Two of the ten classes are translated on the way out.
 * `Unknown` is only ever returned for a clean exit — the classifier's own last
 * rule turns a non-zero exit into `ProcessFailed` — so it is exactly the case
 * of a provider that stopped talking and said nothing, which is what
 * {@link NoTerminalEvent} is. And `TimedOut` is reported as a network failure,
 * because this harness enforces no cap of its own: a timeout in Codex's own text
 * is a request that expired under it, and a real cap belongs to the caller that
 * set one and can name it.
 */
const harnessErrorOf = ({
  eventsSeen,
  exitCode,
  stderr,
  thrown,
}: TurnFailure): HarnessError => {
  const detail =
    `${typeof thrown === "string" ? thrown : ""}\n${stderr}`.trim() ||
    "codex ended without a terminal event";
  switch (classify({ exitCode, stderr, thrown })) {
    case "Interrupted":
      // Something outside this fiber killed the process; a stop command would
      // have interrupted the fiber and never reached here.
      return new Interrupted({ reason: "shutdown" });
    case "NetworkFailed":
    case "TimedOut":
      return new NetworkFailed({ detail });
    case "ProcessFailed":
      return new ProcessFailed({ exitCode: exitCode ?? 1, stderr });
    case "QuotaExhausted":
      return new QuotaExhausted({ detail });
    case "RateLimited":
      // Codex names no retry window on the way out, and an invented one is a
      // backoff the caller would trust.
      return new RateLimited({ retryAfterMs: null });
    case "Unauthenticated":
      return new Unauthenticated({ detail });
    case "ProviderCrashed":
      return new ProviderCrashed({ cause: thrown, message: detail });
    default:
      return new NoTerminalEvent({ eventsSeen });
  }
};

/** The command, with the prompt already on its way to stdin. */
const codexCommand = (options: RunOptions) =>
  ChildProcess.make(CODEX_COMMAND, codexArgs(options), {
    cwd: options.workspaceDir,
    env: codexEnv(options),
    // The provider binary is found on the sandbox's own `PATH`, so the child's
    // environment is the host's with this run's variables layered over it.
    extendEnv: true,
    stdin: Stream.encodeText(Stream.make(options.prompt)),
  });

/**
 * The services one invocation needs. The filesystem is named again alongside
 * the spawner because the spawner keeps its own copy to itself, and the hook
 * definition below is written through this one.
 */
const codexLayer = Layer.mergeAll(spawnerLayer, BunFileSystem.layer);

/**
 * One invocation as a stream. The child is acquired in the stream's own scope,
 * so a consumer that stops consuming — a stop command, a shutdown, a timeout
 * wrapped around this — kills the process group on the way out without anyone
 * having to remember to.
 */
const runCodex = (options: RunOptions) =>
  Stream.unwrap(
    Effect.gen(function* () {
      // Before the child, because Codex reads its hooks out of `CODEX_HOME`
      // once at startup. A definition that cannot be written costs the run its
      // stop hook and nothing else — the orchestrator's fallback message covers
      // the same rule from the other side — so it is a warning, not an ending.
      //
      // TODO: this writes a whole file into a directory every other container
      // is reading. Every run writes identical bytes, so it is idempotent
      // rather than racy, and Codex exposes no flag that takes a hooks path.
      // The fix is a flag, or a hooks file written once at setup.
      yield* writeCodexHooks({
        agentHomeDir: options.agentHomeDir,
        // The command names an executable inside the image, so the sandbox that
        // built the image is what sets it; it reaches us on the process
        // environment rather than through `options.env`.
        env: process.env,
      }).pipe(
        Effect.tapError((cause) =>
          Effect.logWarning("codex stop hook not registered", { cause })
        ),
        Effect.ignore
      );

      const startedAtMs = yield* Clock.currentTimeMillis;
      const state = yield* Ref.make(
        initialCodexTurnState({
          providerSessionId: options.resumeSessionId,
          startedAtMs,
        })
      );
      const stderr = yield* Ref.make("");
      const spawner = yield* ChildProcessSpawner;
      const child = yield* Effect.mapError(
        spawner.spawn(codexCommand(options)),
        crashed
      );

      // Drained rather than sampled: an undrained stderr pipe fills and stops
      // the child, and the tail of it is the only account of a crash.
      yield* child.stderr.pipe(
        Stream.decodeText(),
        Stream.runForEach((chunk) =>
          Ref.update(stderr, (kept) => keepStderrTail(kept + chunk))
        ),
        Effect.ignore,
        Effect.forkScoped
      );

      const events = child.stdout.pipe(
        Stream.decodeText(),
        Stream.splitLines,
        Stream.mapEffect((line) =>
          Effect.flatMap(Clock.currentTimeMillis, (nowMs) =>
            Ref.modify(state, (current) => {
              const stepped = stepCodexLine({ line, nowMs, state: current });
              return [stepped.events, stepped.state];
            })
          )
        ),
        Stream.flattenIterable,
        Stream.mapError(crashed)
      );

      /**
       * Where a failed turn is caught. Codex runs no stop hook on failure, so
       * nothing downstream would otherwise notice: a stream that ends without
       * `turn.completed` fails here, with the exit code and the stderr that
       * explain it.
       */
      const finish = Effect.gen(function* () {
        const exit = yield* Effect.result(child.exitCode);
        const final = yield* Ref.get(state);
        if (final.terminated) {
          return;
        }
        return yield* Effect.fail(
          harnessErrorOf({
            eventsSeen: final.eventsSeen,
            exitCode: Result.isSuccess(exit) ? exit.success : null,
            stderr: yield* Ref.get(stderr),
            // A process killed by a signal has no exit code; the platform's
            // failure names the signal, and the classifier reads it.
            thrown: Result.isFailure(exit)
              ? String(exit.failure)
              : final.fatalMessage,
          })
        );
      });

      const turn = Stream.concat(
        events,
        Stream.drain(Stream.fromEffect(finish))
      );
      return options.signal === null
        ? turn
        : Stream.interruptWhen(turn, abortAsFailure(options.signal));
    })
  ).pipe(Stream.provide(codexLayer));

/**
 * The Codex harness. `cost` is false and stays false: Codex bills a
 * subscription, not a run, and there is no dollar figure anywhere in its output
 * to record.
 */
export const codexProvider: AgentProvider = {
  capabilities: {
    cost: false,
    hooks: true,
    // Nothing in the JSONL reports a quota window, so a Codex run only finds
    // out it is limited by being refused.
    rateLimitSignal: false,
    reasoning: true,
    resume: true,
    subagents: false,
  },
  defaultEffort: CODEX_DEFAULT_EFFORT,
  displayName: "Codex",
  efforts: CODEX_EFFORTS,
  id: PROVIDER_ID,
  models: CODEX_MODELS,
  run: runCodex,
};
