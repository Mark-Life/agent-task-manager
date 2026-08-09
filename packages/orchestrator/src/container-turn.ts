/**
 * One turn, run inside a container. The other half of `./run`'s seam: the local
 * path starts a provider in this process, and this one hands the same work to a
 * sandbox and watches what comes back through the mount.
 *
 * **Nothing about the work changes, only where it happens.** The spec is
 * written into the run directory the container already has mounted, the
 * container appends its normalized events to the file in that same directory,
 * and the host reads them back. Every stage after the turn — the terminus, the
 * message fallback, the ingest, the artifact rescan, the wide event — is handed
 * exactly what the local path hands it, which is the test that the seam was
 * drawn in the right place.
 *
 * **The event file is tailed while the container runs, not after it.** A run
 * takes minutes, and a timeline that only fills in at teardown is a timeline
 * nobody watches, so the file is polled and each new line is stored as it
 * lands. The line's ordinal in the file is its `seq`, unconditionally — a line
 * this build cannot decode spends its ordinal rather than being skipped,
 * exactly as `./ingest` does when it re-reads the same file afterwards. That is
 * what makes the two passes collide row for row on `(runId, seq)` instead of
 * writing a second, shifted copy of the timeline.
 *
 * **The result file is the container's last word and not its only one.** The
 * terminus comes from the `result` event in the stream wherever there is one,
 * because that is where the economics are and it is the same value the local
 * path produces. The result file answers what the stream cannot: a spec the
 * container could not read, a crash before the first event, and the provider
 * session id of a turn that never got as far as saying it. A container that
 * exits having said neither is `lost`, through the constructor that already
 * exists.
 *
 * **Three caps, each below the one outside it.** The loop's own deadline is the
 * outermost; the container's is a `SIGKILL` that leaves no result file behind;
 * the turn's is a `Harness.TimedOut` inside the entrypoint that still writes its
 * events, its row and its last word. Setting them equal would mean the kill
 * always won, and the informative ending would never be the one recorded.
 */

import {
  AgentEventRecord,
  CONTAINER_ENTRYPOINT_COMMAND,
  containerEntrypointArgs,
  containerRunLayout,
  TurnResult,
  TurnSpec,
  turnResultPathOf,
  turnSpecPathOf,
} from "@workspace/harness";
import {
  CONTAINER_AGENT_HOME_DIR,
  CONTAINER_WORKSPACE_DIR,
  hardeningFor,
  hostUser,
  type Mount,
  type OutputChunk,
  Sandbox,
  type SandboxSpec,
  sandboxCpusConfig,
  sandboxMemoryMbConfig,
} from "@workspace/sandbox";
import { Effect, Option, Ref, Schedule, Schema, Semaphore } from "effect";
import { FileSystem } from "effect/FileSystem";
import {
  type DispatchContext,
  eventLogPathOf,
  lostTerminus,
  type RunTerminus,
  resumeSessionIdOf,
  runIdentityOf,
} from "./dispatch-context";
import type { TurnProgress } from "./turn-progress";

/** How often the mounted event file is read while the container is running. */
const TAIL_POLL_MS = 250;

/**
 * How much of a cap the cap inside it gives up, at most, and the fraction used
 * instead when the whole cap is smaller than that.
 *
 * Half a minute is enough for the entrypoint to finish its own teardown and for
 * a container to be removed; on the short caps a test uses, a tenth is the same
 * idea at a scale where thirty seconds would leave nothing at all.
 */
const CAP_HEADROOM_MS = 30_000;
const CAP_HEADROOM_DIVISOR = 10;

/**
 * The cap for the layer inside one that is already set. Pure, so the ordering
 * the module note describes is assertable without starting anything.
 */
export const innerCapMs = (capMs: number) =>
  capMs - Math.min(CAP_HEADROOM_MS, Math.ceil(capMs / CAP_HEADROOM_DIVISOR));

/** Encoder for the spec the container reads off the mount, built once. */
const encodeSpec = Schema.encodeEffect(TurnSpec);

/** One readable line of the container's event file, with the ordinal it arrived on. */
export interface ContainerRecord {
  readonly record: AgentEventRecord;
  /** The 0-based line ordinal in the event file, which is the row's `seq`. */
  readonly seq: number;
}

/** What running one turn in a container needs. */
export interface ContainerTurnInput<R> {
  readonly context: DispatchContext;
  /**
   * Environment on top of the run's own ids, which the sandbox merges in and
   * which win. Never the host's OTLP token — the sandbox strips those anyway.
   */
  readonly env: Readonly<Record<string, string>>;
  /**
   * The exact directories this container sees, already decided.
   *
   * Handed in rather than built here, and that is the seam that keeps this file
   * role-agnostic: what a run may reach is a property of what it is attached to
   * — a task has a checkout and an artifacts folder, a conversation has neither
   * — and deciding it here would be a role check inside the shared turn.
   */
  readonly mounts: readonly Mount[];
  /**
   * Called once per readable line of the event file, in file order, while the
   * container is still running. Total by contract: a recorder that could fail
   * would be bookkeeping aborting the work it describes.
   */
  readonly onRecord: (input: ContainerRecord) => Effect.Effect<void, never, R>;
  /** The cell the turn folds its events into, read once the container is gone. */
  readonly progress: Ref.Ref<TurnProgress>;
  readonly prompt: string;
  /** The loop's own deadline. The container's and the turn's are set below it. */
  readonly timeoutMs: number;
}

/**
 * Where the turn starts, taken from the mount set it was handed.
 *
 * The deepest directory of the run's tree rather than its root, and that is what
 * makes the nesting work at all: both CLIs read instruction files from the
 * working directory *upwards* and concatenate them root-down, while a file below
 * it loads on demand at best. Starting at the workspace scope would collect the
 * house rules and leave the project's conventions and the task's own brief
 * unread — the most specific ones, which is backwards.
 *
 * Read off the mount carrying the `workspace` purpose rather than passed beside
 * the set, so the directory the container is started in is by construction the
 * one that was bound writable there: a worker's checkout, a repo-less run's
 * scratch directory, a chat turn's scratch directory under the manager's scope.
 * Both builders always emit that mount, which is why the fallback below is a
 * value for a case that cannot arise rather than a default anyone relies on.
 */
export const workingDirOf = (mounts: readonly Mount[]) =>
  mounts.find((mount) => mount.purpose === "workspace")?.containerPath ??
  CONTAINER_WORKSPACE_DIR;

/** The spec one turn runs under, in the container's own view of the world. */
export const specFor = (input: {
  readonly context: DispatchContext;
  readonly mounts: readonly Mount[];
  readonly prompt: string;
  readonly timeoutMs: number;
}): TurnSpec => {
  const { context } = input;
  const identity = runIdentityOf(context);
  return {
    agentHomeDir: CONTAINER_AGENT_HOME_DIR,
    effort: null,
    eventLogPath: containerRunLayout.eventLogPath,
    identity: {
      runId: identity.runId,
      sessionId: identity.sessionId,
      taskId: identity.taskId,
      traceparent: identity.traceparent,
      workspaceId: identity.workspaceId,
    },
    model: null,
    prompt: input.prompt,
    provider: context.provider,
    resumeSessionId: resumeSessionIdOf(context),
    timeoutMs: input.timeoutMs,
    workspaceDir: workingDirOf(input.mounts),
  };
};

/** The container one turn runs in, over the directories the run was given. */
export const sandboxSpecFor = (input: {
  readonly context: DispatchContext;
  /** This deployment's quota, from {@link sandboxCpusConfig}. */
  readonly cpus: number;
  readonly env: Readonly<Record<string, string>>;
  /** This deployment's ceiling, from {@link sandboxMemoryMbConfig}. */
  readonly memoryMb: number;
  readonly mounts: readonly Mount[];
  readonly timeoutMs: number;
}): SandboxSpec => ({
  args: [...containerEntrypointArgs()],
  command: CONTAINER_ENTRYPOINT_COMMAND,
  env: input.env,
  hardening: hardeningFor({
    cpus: input.cpus,
    memoryMb: input.memoryMb,
    user: hostUser(),
  }),
  identity: runIdentityOf(input.context),
  image: input.context.image,
  mounts: input.mounts,
  timeoutMs: input.timeoutMs,
  workingDir: workingDirOf(input.mounts),
});

/**
 * The lines of a growing JSONL file that are certainly whole.
 *
 * A poll can catch the writer between its bytes and its newline, so a trailing
 * fragment is left for the next pass rather than read as a truncated event.
 * Blank lines carry no ordinal, which is the rule `./ingest` applies when it
 * re-reads the same file — a trailing newline is how every append ends, and
 * letting the empty tail spend a `seq` would shift the whole file.
 */
export const settledLines = (content: string) => {
  const parts = content.split("\n");
  const whole = content.endsWith("\n") ? parts : parts.slice(0, -1);
  return whole.filter((line) => line.trim().length > 0);
};

const decodeRecord = Schema.decodeUnknownOption(AgentEventRecord);

/** One line of the event file, or nothing where it cannot be read. */
const parseRecord = (line: string) => {
  try {
    return Option.getOrNull(decodeRecord(JSON.parse(line)));
  } catch {
    return null;
  }
};

const decodeResult = Schema.decodeUnknownOption(TurnResult);

/**
 * The container's last word, or null where it left none. Null is an ordinary
 * answer rather than a failure: a container killed before it could write one is
 * exactly the run this exists to describe.
 */
const readTurnResult = Effect.fnUntraced(function* (path: string) {
  const fs = yield* FileSystem;
  const raw = yield* fs
    .readFileString(path)
    .pipe(Effect.orElseSucceed(() => ""));
  try {
    return Option.getOrNull(decodeResult(JSON.parse(raw)));
  } catch {
    return null;
  }
});

/** What a container left behind, once it is gone. */
export interface ContainerEnding {
  /** Null where the container was killed before it produced one. */
  readonly exitCode: number | null;
  readonly progress: TurnProgress;
  readonly result: TurnResult | null;
}

/**
 * How a run whose container has exited ended.
 *
 * The stream's own terminus wins wherever there is one — it carries the
 * economics, and it is the same value the local path produces, so the two
 * cannot report a clean turn differently. The result file covers what the
 * stream could not say: a spec that never decoded, a crash before the first
 * event, an interrupt. Everything else is the `lost` the loop already has a
 * word for, and `no_terminus` is routed there rather than to a failure, because
 * a provider that went quiet is precisely what `lost` means.
 */
export const terminusOfContainer = ({
  exitCode,
  progress,
  result,
}: ContainerEnding): RunTerminus => {
  if (progress.terminus !== null) {
    return { ...progress.terminus, exitCode };
  }
  if (
    result !== null &&
    result.errorClass !== null &&
    result.exitReason !== "no_terminus"
  ) {
    return {
      costUsd: null,
      durationMs: null,
      errorClass: result.errorClass,
      errorMessage: result.errorMessage ?? result.errorClass,
      exitCode,
      finalText: progress.finalText,
      kind: "failed",
      providerSessionId: result.providerSessionId ?? progress.providerSessionId,
      totalTokens: null,
      turns: null,
    };
  }
  return lostTerminus({
    eventsSeen: progress.eventsSeen,
    exitCode,
    finalText: progress.finalText,
    providerSessionId: result?.providerSessionId ?? progress.providerSessionId,
  });
};

/**
 * Runs one turn in a container and answers with how it ended.
 *
 * Fails only where the container never got to say anything for itself — an
 * unreachable daemon, a missing image, a mount source that is not there, the
 * container's own cap. The caller turns those into the same failed terminus a
 * crashed provider produces, which is why there is no second ending vocabulary
 * here. An interrupt propagates untouched: that is a stop command, and it
 * belongs to the run's own `onExit`.
 */
export const containerTurn = <R>(input: ContainerTurnInput<R>) =>
  Effect.gen(function* () {
    const { context, progress } = input;
    const fs = yield* FileSystem;
    const sandbox = yield* Sandbox;

    const containerCapMs = innerCapMs(input.timeoutMs);
    // Read here rather than redeclared in the loop's own config, for the reason
    // `SANDBOX_MODE` is: a second spelling of a container's limits is a loop
    // reporting one confinement on its rows while running another.
    const cpus = yield* sandboxCpusConfig;
    const memoryMb = yield* sandboxMemoryMbConfig;
    const spec = yield* encodeSpec(
      specFor({
        context,
        mounts: input.mounts,
        prompt: input.prompt,
        timeoutMs: innerCapMs(containerCapMs),
      })
    );
    // The prompt travels in this file and nowhere else: an environment variable
    // is printed by `docker inspect` to anyone who can reach the daemon.
    yield* fs.writeFileString(
      turnSpecPathOf(context.layout),
      `${JSON.stringify(spec)}\n`
    );

    const eventLogPath = eventLogPathOf(context);
    const consumed = yield* Ref.make(0);
    // One reader at a time: the poll below and the final read after teardown
    // could otherwise hand the same line to the recorder twice, and a repeated
    // line is a repeated `seq`.
    const reader = yield* Semaphore.make(1);

    /** Every line the file has gained since the last pass, in file order. */
    const drain = reader.withPermits(1)(
      Effect.gen(function* () {
        const content = yield* fs
          .readFileString(eventLogPath)
          .pipe(Effect.orElseSucceed(() => ""));
        const lines = settledLines(content);
        const from = yield* Ref.get(consumed);
        for (let seq = from; seq < lines.length; seq += 1) {
          const record = parseRecord(lines[seq] ?? "");
          // The ordinal is spent either way. A line this build cannot decode
          // still happened, and compacting it away would renumber every event
          // after it — which is the whole basis of a re-ingest colliding.
          if (record !== null) {
            yield* input.onRecord({ record, seq });
          }
          // Advanced per line rather than per pass, so an interrupt mid-pass
          // costs at most the line it landed on rather than replaying the whole
          // batch to the recorder.
          yield* Ref.set(consumed, seq + 1);
        }
      })
    );

    /** Narration: the entrypoint's own log, worth having when a run misbehaves. */
    const onOutput = (chunk: OutputChunk) => {
      const text = chunk.text.trimEnd();
      return text.length === 0
        ? Effect.void
        : Effect.logDebug(text).pipe(
            Effect.annotateLogs({ stream: chunk.stream })
          );
    };

    const ran = yield* Effect.scoped(
      Effect.gen(function* () {
        yield* Effect.forkScoped(
          drain.pipe(Effect.repeat(Schedule.spaced(TAIL_POLL_MS)))
        );
        return yield* sandbox.run({
          onOutput,
          spec: sandboxSpecFor({
            context,
            cpus,
            env: input.env,
            memoryMb,
            mounts: input.mounts,
            timeoutMs: containerCapMs,
          }),
        });
      })
    ).pipe(
      // The tail fiber died with that scope, so this is the last reader, and it
      // runs on every exit path — including the one where the container was
      // torn down mid-sentence and its final lines are all there is.
      Effect.onExit(() => Effect.ignoreCause(drain))
    );

    return terminusOfContainer({
      exitCode: ran.exitCode,
      progress: yield* Ref.get(progress),
      result: yield* readTurnResult(turnResultPathOf(context.layout)),
    });
  }).pipe(Effect.withSpan("Run.container"));
