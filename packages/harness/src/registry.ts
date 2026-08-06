/**
 * The provider table, and the one door onto it.
 *
 * Which harness runs a task is a value on a row: an agent session records the
 * provider it belongs to, and the orchestrator reads it back with no idea which
 * SDK that implies. So the lookup is total and the table is closed — every
 * literal of the domain's `SessionProvider` has an entry, checked by the
 * compiler, because a provider added to the domain and forgotten here should be
 * a build that fails and not a dispatch that finds nothing at three in the
 * morning.
 *
 * The registry also owns the wide event, which is why it exists rather than the
 * table being exported directly. {@link instrumented} wraps each provider's
 * stream so one invocation leaves exactly one `atm.turn` row on every exit path,
 * counted from the normalized events themselves. Doing it here rather than in
 * each harness is what stops the two providers from disagreeing about what a
 * tool call is, and it means a provider implementation stays a stream of events
 * and nothing else. The consequence a caller has to know: this is the only run
 * path that records anything, so the registry is what leaves the package and the
 * individual providers do not.
 */

import type { Settings } from "@anthropic-ai/claude-agent-sdk";
import type { Telemetry } from "@workspace/telemetry";
import { Effect, Layer, Queue, Stream } from "effect";
import { claudeProvider, makeClaudeProvider } from "./claude";
import { readClaudeSettings } from "./claude-settings";
import { codexProvider } from "./codex";
import type { HarnessError } from "./errors";
import type { AgentEvent } from "./events";
import {
  type AgentProvider,
  makeProviderRegistry,
  ProviderRegistry,
  type ProviderTable,
  type RunOptions,
} from "./provider";
import {
  makeTurnCounters,
  observeTurnEvent,
  readTurnIdentity,
  withTurnEvent,
} from "./turn-event";

/**
 * One turn, streamed through the counters that describe it.
 *
 * The provider's stream is consumed inside the wide event rather than beside
 * it, because the event's whole promise is that it is emitted once on every exit
 * path — and the paths that matter are the ones a stream has and an effect does
 * not: a consumer that stops reading, and a stop command that interrupts the
 * fiber mid-stream. Consuming inside means the interrupt lands on the wrapped
 * effect and leaves its row; re-emitting through the queue means the caller sees
 * the same events in the same order, unbuffered by anything but the queue.
 *
 * The queue is completed by the consumption itself, so a failed turn fails the
 * stream with its typed error and a finished one ends it.
 */
const turnStream = (provider: AgentProvider, options: RunOptions) =>
  Stream.callback<AgentEvent, HarnessError, Telemetry>((queue) =>
    Effect.gen(function* () {
      const counters = yield* makeTurnCounters;
      const identity = yield* readTurnIdentity({
        runId: options.runId,
        taskId: options.taskId,
      });
      const consume = Stream.runForEach(provider.run(options), (event) =>
        Effect.andThen(
          observeTurnEvent(counters, event),
          Queue.offer(queue, event)
        )
      );
      return yield* consume.pipe(
        withTurnEvent({
          agentHomeSet: options.agentHomeDir.length > 0,
          counters,
          // The effort that applied, not the one named: a null from the caller
          // means the provider's own default, and the default is knowable right
          // here — leaving the field null would drop every unconfigured run out
          // of a `GROUP BY effort`.
          effort: options.effort ?? provider.defaultEffort,
          identity,
          model: options.model,
          promptChars: options.prompt.length,
          provider: provider.id,
          resumed: options.resumeSessionId !== null,
        }),
        Queue.into(queue)
      );
    })
  );

/**
 * The same provider, running its turns under the wide event. The declarations —
 * capabilities, models, efforts — pass through untouched: they are answers about
 * the provider, and nothing about instrumenting a run changes them.
 *
 * Exported for the test that holds it to its promise against a scripted stream;
 * it is not part of the package's surface, because the table below is the only
 * place a real provider should be wrapped.
 */
export const instrumented = (provider: AgentProvider): AgentProvider => ({
  ...provider,
  run: (options) => turnStream(provider, options),
});

/**
 * Every harness this system can run, keyed by the value a session row stores.
 * Instrumented on the way in, so there is no uninstrumented entry to pick up by
 * accident.
 *
 * Only Claude takes a settings argument, because only Claude has a settings file
 * to override: Codex reads its own configuration and the harness renders it per
 * run.
 */
export const providerTableWith = (claudeSettings: Settings): ProviderTable => ({
  claude: instrumented(makeClaudeProvider(claudeSettings)),
  codex: instrumented(codexProvider),
});

/** The table under the hardened defaults, with nothing read from anywhere. */
export const providerTable: ProviderTable = {
  claude: instrumented(claudeProvider),
  codex: instrumented(codexProvider),
};

/** The registry over {@link providerTable}. Pure, and built once. */
export const providerRegistry = makeProviderRegistry(providerTable);

/**
 * The registry as a service, over the settings the environment configured.
 *
 * Effectful rather than a plain value, because the operator's overlay is read
 * here: at layer build, once, in the process that is about to run turns. That
 * placement is the whole point — a settings file that does not parse fails the
 * build with the variable named, instead of quietly running an agent under
 * defaults nobody chose. Nothing else here opens anything.
 */
export const providerRegistryLayer = Layer.effect(
  ProviderRegistry,
  Effect.map(readClaudeSettings, (claudeSettings) =>
    makeProviderRegistry(providerTableWith(claudeSettings))
  )
);
