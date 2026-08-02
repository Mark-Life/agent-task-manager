/**
 * The docker implementation of {@link Sandbox}: one container per run, created,
 * streamed, waited on, inspected, and removed.
 *
 * The whole lifetime is one operation because the guarantees are only true
 * jointly. A container is removed on every exit path — a clean finish, a typed
 * failure, a defect, and above all an interrupt, which is what a stop command
 * produces and therefore the common case rather than the exotic one. That is why
 * the removal is registered with {@link Effect.acquireRelease} *before* the
 * container can exist: a fiber killed between the spawn and the first byte of
 * output still has a name to remove, and a release runs uninterruptibly. There is
 * no `kill` method anywhere in this package for the same reason — interrupting
 * the fiber is how a run is stopped, and nothing else needs to be remembered.
 *
 * Killing the docker client is not killing the container. The CLI is a client of
 * a daemon that owns the process; a `SIGTERM` to the client detaches it and
 * leaves the container running, holding a memory limit's worth of the host and a
 * copy of a live subscription credential on a mount. `docker rm --force` in the
 * release is the thing that actually ends it, which is why teardown is a
 * separate command rather than a consequence of the fiber dying.
 *
 * Three facts the `atm.sandbox` row needs are only readable between the
 * container exiting and the container being removed — the kernel's OOM verdict,
 * the real exit code, and the container id — so `docker inspect` runs inside the
 * scope, before the release, and `--rm` is never passed. Peak memory is not
 * readable there at all: a stopped container's cgroup is gone, so it is sampled
 * while the run is alive by a `docker stats` reader forked into the same scope.
 * Every one of those is best-effort and degrades to a null on the row, because
 * telemetry may not fail the work it describes.
 *
 * A non-zero exit code is not a failure of this module, and neither is an
 * OOM kill. The first is an agent's failing test suite; the second is the kernel
 * ending a container that really ran, produced output and left a transcript. Both
 * are fields on {@link SandboxResult}. The failure channel holds only the things
 * that stopped a run from happening at all: an unreachable daemon, a missing
 * image, a missing mount source, a container that never started, and the cap
 * this module enforces itself.
 */

import { randomUUID } from "node:crypto";
import * as BunChildProcessSpawner from "@effect/platform-bun/BunChildProcessSpawner";
import * as BunFileSystem from "@effect/platform-bun/BunFileSystem";
import * as BunPath from "@effect/platform-bun/BunPath";
import type { RunId } from "@workspace/domain";
import {
  clipError,
  Telemetry,
  type TelemetryInterface,
} from "@workspace/telemetry";
import {
  Clock,
  Duration,
  Effect,
  Layer,
  Ref,
  Result,
  Schedule,
  Stream,
} from "effect";
import { FileSystem } from "effect/FileSystem";
import * as ChildProcess from "effect/unstable/process/ChildProcess";
import { ChildProcessSpawner } from "effect/unstable/process/ChildProcessSpawner";
import {
  containerEnv,
  containerName,
  DOCKER_COMMAND,
  dockerRunArgs,
  type InspectedContainer,
  imageInspectArgs,
  inspectArgs,
  NONCE_CHARS,
  parseInspect,
  parseMemUsage,
  removeArgs,
  statsArgs,
} from "./docker-argv";
import {
  ContainerStartFailed,
  classifySandboxFailure,
  DaemonUnreachable,
  ImageMissing,
  keepStderrTail,
  MountSourceMissing,
  type SandboxError,
  SandboxTimedOut,
} from "./errors";
import { type Mount, mountSourcePaths } from "./mounts";
import {
  type LabelledContainer,
  orphanListArgs,
  parseOrphanList,
} from "./reap";
import {
  makeSandboxProgress,
  observeSandboxProgress,
  type SandboxProgress,
  withSandboxEvent,
  withSubprocessSpan,
} from "./sandbox-event";
import {
  Sandbox,
  type SandboxResult,
  type SandboxRunInput,
  type SandboxSpec,
  type TeardownOutcome,
} from "./spec";

/** The kind every result from this module carries. */
const KIND = "docker";

/** A command that finished cleanly, as the CLI reports it. */
const OK_EXIT = 0;

/**
 * How often a running container's memory is read.
 *
 * One `docker stats --no-stream` costs the CLI a couple of seconds, so this is
 * roughly a third of one process kept busy per running container — cheap beside
 * the container itself, and the granularity a peak needs when the runs being
 * measured last minutes.
 */
const MEMORY_SAMPLE_SECONDS = 5;
const MEMORY_SAMPLE_INTERVAL = Duration.seconds(MEMORY_SAMPLE_SECONDS);

/** What one short-lived docker command produced. */
interface CommandOutput {
  /** Null where the process was killed before it produced one. */
  readonly exitCode: number | null;
  readonly stderr: string;
  readonly stdout: string;
}

/** One docker subcommand run to completion, with both its streams collected. */
const runDocker = (
  spawner: ChildProcessSpawner["Service"],
  args: readonly string[]
) =>
  Effect.gen(function* () {
    const handle = yield* spawner.spawn(
      ChildProcess.make(DOCKER_COMMAND, [...args], { stdin: "ignore" })
    );
    const [stdout, stderr] = yield* Effect.all(
      [
        Stream.mkString(Stream.decodeText(handle.stdout)),
        Stream.mkString(Stream.decodeText(handle.stderr)),
      ],
      { concurrency: 2 }
    );
    const exit = yield* Effect.result(handle.exitCode);
    return {
      exitCode: Result.isSuccess(exit) ? exit.success : null,
      stderr,
      stdout,
    } satisfies CommandOutput;
  }).pipe(Effect.scoped);

/**
 * The same, under a span named by its subcommand. The naming goes through
 * {@link withSubprocessSpan} rather than a template here, because that function
 * is the package's single implementation of "a span never carries an argv" — and
 * a docker command line is unbounded and occasionally holds a registry
 * credential.
 */
const capture = (
  spawner: ChildProcessSpawner["Service"],
  args: readonly string[]
) => runDocker(spawner, args).pipe(withSubprocessSpan(DOCKER_COMMAND, args));

/**
 * Whether the daemon already holds the image.
 *
 * Asked before the run and never after, because afterwards the answer is always
 * yes: this is the only moment at which the cold-start half of a slow run is
 * still attributable. A failure to ask is reported as cached, which understates
 * a pull rather than inventing one.
 */
const imageCached = (spawner: ChildProcessSpawner["Service"], image: string) =>
  capture(spawner, imageInspectArgs(image)).pipe(
    Effect.map((output) => output.exitCode === OK_EXIT),
    Effect.orElseSucceed(() => true)
  );

/**
 * Every mount source, checked on the host before the container starts.
 *
 * `--mount` would refuse to start the container anyway, but it refuses with a
 * message about an "invalid mount config" that names neither the path nor which
 * of five it was — so the cheap check here is what turns a typo in the data root
 * into an error a human can act on. A path that cannot be stat'd counts as
 * missing: the container would not have been able to use it either.
 */
const verifyMountSources = (fs: FileSystem, mounts: readonly Mount[]) =>
  Effect.forEach(mountSourcePaths(mounts), (source) =>
    fs.exists(source.path).pipe(
      Effect.orElseSucceed(() => false),
      Effect.flatMap((present) =>
        present
          ? Effect.void
          : Effect.fail(
              new MountSourceMissing({
                hostPath: source.path,
                purpose: source.purpose,
              })
            )
      )
    )
  );

/** A name for this attempt's container, unique against a container the last one leaked. */
const mintContainerName = (runId: RunId) =>
  Effect.sync(() =>
    containerName({
      nonce: randomUUID().slice(0, NONCE_CHARS),
      runId,
    })
  );

/**
 * The container removed, and the outcome recorded rather than raised.
 *
 * A leftover container is a real leak — of a memory limit, of disk, and of the
 * credential copy on its mounts — but it is not the run's outcome: the work
 * already succeeded or failed on its own terms, and relabelling it after the
 * fact would misreport both. The warning is what makes the leak visible, and the
 * `failed` outcome on the row is what makes it countable.
 *
 * `docker rm --force` exits zero when there is nothing to remove, so the
 * start-failure path records `removed` truthfully: nothing is left behind.
 */
const removeContainer = (input: {
  readonly name: string;
  readonly progress: Ref.Ref<SandboxProgress>;
  readonly spawner: ChildProcessSpawner["Service"];
}) => {
  const record = (teardown: TeardownOutcome) =>
    observeSandboxProgress(input.progress, { teardown });
  return capture(input.spawner, removeArgs(input.name)).pipe(
    Effect.flatMap((output) =>
      output.exitCode === OK_EXIT
        ? record("removed")
        : Effect.logWarning("container not removed", output.stderr).pipe(
            Effect.andThen(record("failed"))
          )
    ),
    Effect.catchCause((cause) =>
      Effect.logWarning("container teardown failed", cause).pipe(
        Effect.andThen(record("failed"))
      )
    )
  );
};

/** The container's final state, or null where the daemon has nothing to say about it. */
const inspectContainer = (
  spawner: ChildProcessSpawner["Service"],
  name: string
) =>
  capture(spawner, inspectArgs(name)).pipe(
    Effect.map((output) =>
      output.exitCode === OK_EXIT ? parseInspect(output.stdout) : null
    ),
    Effect.orElseSucceed(() => null)
  );

/** What the memory sampler reads, and where it puts what it read. */
interface MemoryWatchInput {
  readonly name: string;
  readonly progress: Ref.Ref<SandboxProgress>;
  readonly spawner: ChildProcessSpawner["Service"];
}

/**
 * One reading, folded into the peak on the accumulator. Absent readings are the
 * normal case rather than an error: a container that is not up yet, one already
 * gone, and a CLI that failed all read the same here, and none of them may reach
 * the run they describe.
 */
const sampleMemory = (input: MemoryWatchInput) =>
  runDocker(input.spawner, statsArgs(input.name)).pipe(
    Effect.flatMap((output) => {
      const bytes = parseMemUsage(output.stdout);
      return bytes === null
        ? Effect.void
        : Ref.update(input.progress, (current) => ({
            ...current,
            peakMemoryBytes: Math.max(current.peakMemoryBytes ?? 0, bytes),
          }));
    }),
    Effect.ignoreCause
  );

/**
 * Samples the container's memory for as long as it runs, keeping the peak.
 *
 * Polled rather than streamed, and the reason is in {@link statsArgs}: this
 * fiber is stopped by interrupting it, and the only form of it that can actually
 * be interrupted is one that spends its life between short-lived children rather
 * than blocked on a pipe. A peak nobody managed to measure is a null on the row,
 * which is the honest answer for a container that lived less than one interval.
 */
const watchMemory = (input: MemoryWatchInput) =>
  sampleMemory(input).pipe(
    Effect.repeat(Schedule.spaced(MEMORY_SAMPLE_INTERVAL)),
    withSubprocessSpan(DOCKER_COMMAND, statsArgs(input.name))
  );

/** What a container that never ran hands the classifier. */
interface StartFailureShape {
  readonly exitCode: number | null;
  readonly image: string;
  readonly stderr: string;
}

/**
 * Names the failure behind a container that produced no run.
 *
 * Only two classes are worth telling apart here, and they are the two whose
 * recoveries differ: an unreachable daemon pauses dispatch because every other
 * run is about to hit it too, and a missing image waits for a build that a run
 * cannot trigger. Everything else — a refused limit, an OCI runtime error, a
 * bad entrypoint — is one thing to the orchestrator, and inventing finer names
 * for it would be guessing from a daemon's prose.
 */
const startFailure = ({
  exitCode,
  image,
  stderr,
}: StartFailureShape): SandboxError => {
  const detail = clipError(stderr);
  switch (classifySandboxFailure({ exitCode, stderr })) {
    case "DaemonUnreachable":
      return new DaemonUnreachable({ detail });
    case "ImageMissing":
      return new ImageMissing({ detail, image });
    default:
      return new ContainerStartFailed({
        exitCode,
        image,
        stderr: keepStderrTail(stderr),
      });
  }
};

/** What the container itself produced, once it has exited and been inspected. */
interface ContainerFacts {
  readonly containerId: string;
  readonly exitCode: number | null;
  readonly oomKilled: boolean;
  /** Measured from spawn to exit, so it describes the container and not the teardown. */
  readonly wallClockMs: number;
}

/** The facts a completed container leaves, from its inspect and the clock. */
const factsOf = (
  inspected: InspectedContainer,
  wallClockMs: number
): ContainerFacts => ({
  containerId: inspected.containerId,
  exitCode: inspected.exitCode,
  oomKilled: inspected.oomKilled,
  wallClockMs,
});

/**
 * Output is narration: a pipe that breaks mid-run loses lines, not the run. The
 * container's fate comes from its exit code and its inspect, both of which
 * outlive the stream.
 */
const narration = <A, E, R>(stream: Stream.Stream<A, E, R>) =>
  Stream.catchCause(stream, (cause) =>
    Stream.drain(
      Stream.fromEffect(
        Effect.logWarning("container output ended early", cause)
      )
    )
  );

/** Everything one container attempt needs, including where its facts accumulate. */
interface AttemptInput<E, R> {
  readonly name: string;
  readonly onOutput: SandboxRunInput<E, R>["onOutput"];
  readonly progress: Ref.Ref<SandboxProgress>;
  readonly spawner: ChildProcessSpawner["Service"];
  readonly spec: SandboxSpec;
}

/**
 * One container, inside a scope that owns its removal.
 *
 * The order is the design. The release is registered first, so there is no
 * instant at which a container could exist without something committed to
 * removing it. The two output streams are drained concurrently and to
 * completion — an undrained pipe fills and stops the container, and the tail of
 * stderr is the only account of a start that failed — and only then is the exit
 * code awaited, so the result never arrives before the output it describes.
 */
const attempt = <E, R>(input: AttemptInput<E, R>) =>
  Effect.gen(function* () {
    const { name, onOutput, progress, spawner, spec } = input;
    yield* Effect.acquireRelease(Effect.void, () =>
      removeContainer({ name, progress, spawner })
    );

    const startedAtMs = yield* Clock.currentTimeMillis;
    const handle = yield* spawner
      .spawn(
        ChildProcess.make(
          DOCKER_COMMAND,
          [...dockerRunArgs({ containerName: name, spec })],
          {
            // The ids and settings ride the CLI's own environment; the argv
            // names them and never carries a value. `extendEnv` is what lets
            // the CLI still find its socket and its config on the host.
            env: containerEnv(spec),
            extendEnv: true,
            stdin: "ignore",
          }
        )
      )
      .pipe(
        // Nothing ran, and the CLI itself could not be started: for the
        // orchestrator that is the same posture as a daemon that is down, and
        // the same recovery — pause, do not burn tasks against it.
        Effect.mapError(
          (cause) => new DaemonUnreachable({ detail: clipError(String(cause)) })
        )
      );

    // Forked into this scope, so it stops when the container does and never
    // outlives the run it is measuring.
    yield* Effect.forkScoped(watchMemory({ name, progress, spawner }));

    const stderrTail = yield* Ref.make("");
    const drain = Effect.all(
      [
        Stream.runForEach(narration(Stream.decodeText(handle.stdout)), (text) =>
          onOutput({ stream: "stdout", text })
        ),
        Stream.runForEach(narration(Stream.decodeText(handle.stderr)), (text) =>
          Ref.update(stderrTail, (kept) => keepStderrTail(kept + text)).pipe(
            Effect.andThen(onOutput({ stream: "stderr", text }))
          )
        ),
      ],
      { concurrency: 2 }
    );

    const finish = drain.pipe(Effect.andThen(Effect.result(handle.exitCode)));
    const { timeoutMs } = spec;
    const exit = yield* timeoutMs === null
      ? finish
      : Effect.timeoutOrElse(finish, {
          duration: Duration.millis(timeoutMs),
          // The interrupt propagates into the scope, so the container is
          // removed on the way out rather than left running past its cap.
          orElse: () => Effect.fail(new SandboxTimedOut({ timeoutMs })),
        });

    const endedAtMs = yield* Clock.currentTimeMillis;
    const inspected = yield* inspectContainer(spawner, name);
    const tail = keepStderrTail(yield* Ref.get(stderrTail));
    // `StartedAt` rather than the exit code, because the codes overlap: docker
    // reports "no such command" as 127 and so does a shell inside a container
    // that ran fine. Under `--init` the second is the common case — pid 1
    // starts, fails to exec, and exits 127 — and that container really ran, so
    // its 127 is the command's business and lands on the result as data.
    if (inspected === null || !inspected.started) {
      const exitCode =
        inspected?.exitCode ?? (Result.isSuccess(exit) ? exit.success : null);
      // The row for a run that never started is built from the accumulator
      // alone, so what is known has to be on it before the failure is raised.
      yield* observeSandboxProgress(progress, {
        containerId: inspected?.containerId ?? null,
        exitCode,
        stderrTail: tail,
      });
      return yield* Effect.fail(
        startFailure({
          exitCode,
          image: spec.image,
          // The runtime's own reason first: it says which binary was missing or
          // which limit the host refused, where the CLI's stderr says only that
          // the container could not be created.
          stderr: `${inspected?.error ?? ""}\n${tail}`.trim(),
        })
      );
    }
    const facts = factsOf(inspected, endedAtMs - startedAtMs);
    yield* observeSandboxProgress(progress, {
      containerId: facts.containerId,
      exitCode: facts.exitCode,
      oomKilled: facts.oomKilled,
      stderrTail: tail,
    });
    return facts;
  });

/** The dependencies captured once when the layer is built, so `run` needs none. */
interface DockerDeps {
  readonly fs: FileSystem;
  readonly spawner: ChildProcessSpawner["Service"];
  /**
   * Held rather than required, because {@link SandboxInterface} promises a run
   * needs nothing the caller did not already have — a `Telemetry` in the run's
   * own requirements would make every caller of `sandbox.run` provide the
   * emitter for a row it does not know exists.
   */
  readonly telemetry: TelemetryInterface;
}

/** The docker sandbox, over already-resolved services. */
const makeDocker = ({ fs, spawner, telemetry }: DockerDeps) => {
  const run = <E, R>({ onOutput, spec }: SandboxRunInput<E, R>) =>
    Effect.gen(function* () {
      const progress = yield* makeSandboxProgress;
      const work = Effect.gen(function* () {
        yield* verifyMountSources(fs, spec.mounts);
        const cached = yield* imageCached(spawner, spec.image);
        yield* observeSandboxProgress(progress, { imagePulled: !cached });
        const name = yield* mintContainerName(spec.identity.runId);

        // Scoped here rather than around the whole method, because the teardown
        // outcome is part of the answer and is only known once the scope closed.
        const facts = yield* Effect.scoped(
          attempt({ name, onOutput, progress, spawner, spec })
        );
        const observed = yield* Ref.get(progress);

        return {
          containerId: facts.containerId,
          exitCode: facts.exitCode,
          image: spec.image,
          imagePulled: !cached,
          kind: KIND,
          mountCount: spec.mounts.length,
          oomKilled: facts.oomKilled,
          peakMemoryBytes: observed.peakMemoryBytes,
          // Only a removal that reported success relaxes this, so a release
          // that never ran reads as a leak rather than as a clean teardown.
          teardown: observed.teardown ?? "failed",
          wallClockMs: facts.wallClockMs,
        } satisfies SandboxResult;
      });
      // The row, the metric and the `sandbox.run` span all hang off this: one
      // `atm.sandbox` event per container on every exit path, built from the
      // accumulator so a run that died before it had a result still leaves one.
      return yield* work.pipe(
        withSandboxEvent({ kind: KIND, progress, spec }),
        Effect.provideService(Telemetry, telemetry)
      );
    });

  /**
   * What the daemon is holding, or nothing at all when it cannot be asked.
   *
   * A sweep is housekeeping, and housekeeping that fails a boot is worse than
   * the containers it meant to remove — a daemon that cannot answer `ps` is
   * about to fail the first dispatch anyway, with a message about the run rather
   * than about the tidying.
   */
  const held = capture(spawner, orphanListArgs()).pipe(
    Effect.map((output) =>
      output.exitCode === OK_EXIT ? parseOrphanList(output.stdout) : []
    ),
    Effect.catchCause((cause) =>
      Effect.logWarning("containers could not be listed", cause).pipe(
        Effect.as([] as readonly LabelledContainer[])
      )
    )
  );

  const remove = (name: string) =>
    capture(spawner, removeArgs(name)).pipe(
      Effect.flatMap((output) =>
        output.exitCode === OK_EXIT
          ? Effect.void
          : Effect.logWarning("container not removed", {
              name,
              stderr: output.stderr,
            })
      ),
      Effect.catchCause((cause) =>
        Effect.logWarning("container removal failed", cause)
      )
    );

  return Sandbox.of({ held, remove, run });
};

/** The docker sandbox as an effect, for a caller that already has the services. */
export const dockerSandbox = Effect.gen(function* () {
  const fs = yield* FileSystem;
  const spawner = yield* ChildProcessSpawner;
  const telemetry = yield* Telemetry;
  return makeDocker({ fs, spawner, telemetry });
});

/**
 * Bun's process spawner and the filesystem it needs. Named explicitly rather
 * than taken from the aggregate platform layer, which would also construct a
 * terminal and claim the host's stdin — in a service that runs containers on a
 * schedule, that is a process fighting the operator for the console.
 */
const platformLayer = Layer.mergeAll(
  BunChildProcessSpawner.layer.pipe(
    Layer.provide(Layer.mergeAll(BunFileSystem.layer, BunPath.layer))
  ),
  BunFileSystem.layer
);

/**
 * The docker sandbox, ready to provide. This is what a dispatched run uses; the
 * local implementation is the debugging escape hatch and swapping between them
 * is one layer.
 */
export const dockerSandboxLayer = Layer.effect(Sandbox, dockerSandbox).pipe(
  Layer.provide(platformLayer)
);
