/**
 * The Pi harness: one `pi --mode json` invocation, its JSONL stdout torn down
 * with the fiber that consumes it, and honest flags about a harness that ships
 * less than the other two.
 *
 * Pi ships an SDK and an RPC mode, and this file uses neither, for the reasons
 * the Codex harness gives beside it: the CLI is the thing an operator can run
 * by hand to reproduce a turn, spawning it directly keeps the child's stderr —
 * which is where an unauthenticated run says so — and ties teardown to a scope
 * rather than to an `AbortSignal` somebody has to remember to fire.
 *
 * **What makes Pi worth a third entry in the table is `--model`.** Pi carries a
 * provider catalog and reads `models.json` out of its own config directory, so
 * an OpenAI-shaped endpoint, an OpenRouter id or a model on a box in the corner
 * is a file in the agent home rather than a change here. That is why this file
 * declares no model list: the set of models is the operator's, the string is
 * passed to `--model` verbatim, and a list compiled in would be a guess about
 * somebody else's catalog that fails a dispatch when it is wrong.
 *
 * **Pi exits zero on a turn that failed**, so the exit code is not the
 * classification — see `./pi-events`, which reads the outcome off the last
 * message. The exit code is consulted here for one case only: a stream that
 * stopped before Pi settled, which is the child dying rather than the turn
 * ending.
 *
 * **There is no stop hook and there are no subagents.** Pi has neither, and the
 * capabilities below say so rather than claiming a check that never runs. The
 * consequence is that the rule forcing a second turn out of a run which posted
 * no message is unenforced on Pi, and the orchestrator's own fallback message is
 * what covers it. On a manager turn the hook is not registered at all — the
 * entrypoint asks `messageRuleApplies` first — so a manager-only Pi loses
 * nothing.
 *
 * **`RunOptions.mcpServers` is ignored here, and it has to be.** Pi ships no
 * MCP client, so there is nothing to hand a server map to; a turn that needs
 * the board gets it as a Pi extension instead, which is
 * `packages/agent-tools/src/pi-extension.ts`, bundled beside the MCP server by
 * `bun run agent-mcp:build` and loaded with `pi -e <path>`. Wiring that into a
 * dispatch is deliberately not done here: nothing can select Pi for a manager
 * turn until "Choose the manager's provider and model separately from the
 * worker's" lands, and the two flags it will need — `-e` for the extension and
 * `--no-builtin-tools` for a chat agent that has no use for `edit` and `write`
 * — are decisions about a role, which is what that card is about.
 */

import { Clock, Effect, Ref, Result, Stream } from "effect";
import * as ChildProcess from "effect/unstable/process/ChildProcess";
import { ChildProcessSpawner } from "effect/unstable/process/ChildProcessSpawner";
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
import { initialPiTurnState, PROVIDER_ID, stepPiLine } from "./pi-events";
import type { AgentProvider, Choice, RunOptions } from "./provider";
import { abortAsFailure, crashed, spawnerLayer } from "./subprocess";

/** The binary, resolved on `PATH` inside whatever sandbox the run got. */
const PI_COMMAND = "pi";

/** Emits the event protocol `./pi-events` parses, one JSON object per line. */
const JSON_MODE_FLAGS = ["--mode", "json"] as const;

/**
 * The reasoning levels Pi accepts, as its `--thinking` flag spells them.
 *
 * `off` is a level and not an absence: a reasoning-capable model asked for
 * `off` answers without thinking, which is the cheap setting a manager on a
 * small model wants.
 */
const PI_EFFORTS: readonly Choice[] = [
  { id: "off", label: "Off" },
  { id: "minimal", label: "Minimal" },
  { id: "low", label: "Low" },
  { id: "medium", label: "Medium" },
  { id: "high", label: "High" },
  { id: "xhigh", label: "Extra high" },
  { id: "max", label: "Maximum" },
];

/**
 * The models this harness offers, which is none — and that is the feature.
 *
 * Pi's catalog is its built-in provider table plus whatever `models.json` in
 * the agent home adds, resolved at startup and reloadable without a restart.
 * Any list here would be a copy of part of that, stale the first time an
 * operator edits the file, and a stale id is a dispatch that fails on a model
 * nobody offers. A caller that names nothing gets whichever model Pi's own
 * settings select; a caller that names one has it passed through untouched.
 */
const PI_MODELS: readonly Choice[] = [];

/**
 * Pi's own configuration, set before the caller's so a host can override it.
 *
 * Both entries are about running headless in a fleet rather than on a laptop.
 * The version check is a request to `pi.dev` on the startup path of every turn,
 * which buys a container that lives for one turn nothing at all; the telemetry
 * switch covers install/update reporting and the provider attribution headers,
 * which are a choice about the operator's traffic and not one this harness
 * should be making silently on their behalf — so it is set here, once, where
 * they can see it and unset it.
 *
 * `PI_OFFLINE` is deliberately not set: it would also stop the model-catalog
 * refresh, and the catalog is the whole reason this provider is in the table.
 */
const PI_HYGIENE_ENV = {
  PI_SKIP_VERSION_CHECK: "1",
  PI_TELEMETRY: "0",
} as const;

/**
 * The argument list for one invocation.
 *
 * The prompt is not in it. Pi merges piped stdin into the initial prompt in
 * every non-interactive mode, and a brief plus its message thread outgrows what
 * an argument list will carry — and an argument list is world-readable in the
 * process table, which a prompt quoting a task's contents should not be.
 *
 * `--session` takes an id as readily as a path, and the id is what this system
 * has: the transcript is addressed by the same value, so the resume and the
 * read agree by construction rather than by a filename either one composed.
 */
export const piArgs = (options: RunOptions): readonly string[] => [
  ...JSON_MODE_FLAGS,
  ...(options.model === null ? [] : ["--model", options.model]),
  ...(options.effort === null ? [] : ["--thinking", options.effort]),
  ...(options.resumeSessionId === null
    ? []
    : ["--session", options.resumeSessionId]),
];

/**
 * The environment for one invocation. `PI_CODING_AGENT_DIR` is merged last
 * because it is what points the CLI at the mounted system-owned home — where
 * the credential is, where `models.json` is, and where the session this run's
 * transcript is read from has to land.
 *
 * The caller's own environment sits between the two, so a host can turn the
 * hygiene defaults back off and cannot accidentally relocate the home.
 */
export const piEnv = (
  options: RunOptions
): Readonly<Record<string, string | undefined>> => ({
  ...PI_HYGIENE_ENV,
  ...options.env,
  ...agentHomeEnvAt(PROVIDER_ID, options.agentHomeDir),
});

/** What a finished invocation knows about why it produced no terminus. */
interface TurnFailure {
  readonly eventsSeen: number;
  readonly exitCode: number | null;
  readonly stderr: string;
  readonly thrown: unknown;
}

/**
 * Names the failure behind a stream that stopped before Pi settled.
 *
 * Only reached when there is no terminus, which for Pi means the child died:
 * an ordinary refusal — a bad key, an unreachable endpoint, three exhausted
 * retries — settles with `stopReason: "error"` and is carried out as a `result`
 * with an outcome, not as a failed stream.
 *
 * The classification is the shared one, so all three harnesses read the same
 * stderr the same way, and the same two classes are translated on the way out
 * as in the Codex harness: `Unknown` after a clean exit is exactly a provider
 * that stopped talking and said nothing, and a `TimedOut` in the vendor's own
 * text is a request that expired rather than a cap this harness enforced.
 */
const harnessErrorOf = ({
  eventsSeen,
  exitCode,
  stderr,
  thrown,
}: TurnFailure): HarnessError => {
  const detail =
    `${typeof thrown === "string" ? thrown : ""}\n${stderr}`.trim() ||
    "pi ended without settling";
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
      // Pi names no retry window on the way out, and an invented one is a
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
const piCommand = (options: RunOptions) =>
  ChildProcess.make(PI_COMMAND, piArgs(options), {
    cwd: options.workspaceDir,
    env: piEnv(options),
    // The provider binary is found on the sandbox's own `PATH`, so the child's
    // environment is the host's with this run's variables layered over it.
    extendEnv: true,
    stdin: Stream.encodeText(Stream.make(options.prompt)),
  });

/**
 * One invocation as a stream. The child is acquired in the stream's own scope,
 * so a consumer that stops consuming — a stop command, a shutdown, a timeout
 * wrapped around this — kills the process group on the way out without anyone
 * having to remember to.
 */
const runPi = (options: RunOptions) =>
  Stream.unwrap(
    Effect.gen(function* () {
      const startedAtMs = yield* Clock.currentTimeMillis;
      const state = yield* Ref.make(
        initialPiTurnState({
          providerSessionId: options.resumeSessionId,
          startedAtMs,
        })
      );
      const stderr = yield* Ref.make("");
      const spawner = yield* ChildProcessSpawner;
      const child = yield* Effect.mapError(
        spawner.spawn(piCommand(options)),
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
              const stepped = stepPiLine({ line, nowMs, state: current });
              return [stepped.events, stepped.state];
            })
          )
        ),
        Stream.flattenIterable,
        Stream.mapError(crashed)
      );

      /**
       * Where a child that died is caught. A turn Pi finished — well or badly —
       * has already emitted its terminus, so reaching a failure here means the
       * process stopped mid-stream, and the exit code and stderr are the only
       * account of why.
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
  ).pipe(Stream.provide(spawnerLayer));

/**
 * The Pi harness, with the flags it can actually stand behind.
 *
 * `cost` is true and it is real money. Pi runs on the operator's own API key
 * rather than on a subscription, and it prices every request itself from the
 * catalog that resolved the model — including a `models.json` entry's own
 * `cost` block — so the dollar figure arrives with the turn. Nothing in
 * `@workspace/domain`'s price table is consulted for a Pi run and nothing needs
 * to be added to it: that table exists because the other two vendors write
 * tokens and no money, which is the opposite problem. The figure is only as
 * good as the rates Pi holds, and a custom provider whose `models.json` names
 * no cost prices at zero — which is why a zero here means "the catalog said
 * zero" and is worth knowing about before it is trusted.
 *
 * `hooks` is false because Pi has no stop hook to register.
 *
 * `rateLimitSignal` is false: nothing in the JSON stream reports a quota
 * window, so a Pi run finds out it is limited by being refused.
 *
 * `reasoning` is true — thinking blocks arrive on the assistant message and are
 * measured — though a model with no reasoning at all produces none, which is
 * the ordinary case for the cheap models this provider exists to reach.
 *
 * `resume` is true: `--session <id>` reopens the conversation the id names and
 * appends to the same file.
 *
 * `subagents` is false. Pi has none, by design and by its own documentation.
 */
export const piProvider: AgentProvider = {
  capabilities: {
    cost: true,
    hooks: false,
    rateLimitSignal: false,
    reasoning: true,
    resume: true,
    subagents: false,
  },
  // Pi's own default is `defaultThinkingLevel` in the settings file inside the
  // agent home, which is the operator's to set and not something this harness
  // can read at declaration time. Naming a level here would put a value on
  // every unconfigured run's ledger row that nothing verified.
  defaultEffort: null,
  displayName: "Pi",
  efforts: PI_EFFORTS,
  id: PROVIDER_ID,
  models: PI_MODELS,
  run: runPi,
};
