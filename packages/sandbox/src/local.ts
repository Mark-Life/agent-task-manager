/**
 * The same {@link Sandbox} interface, served by a plain child process on the
 * host. Read the next three paragraphs before reaching for it.
 *
 * **This mode isolates nothing.** There is no container, so there is no
 * namespace, no cgroup and no mount table: the command runs as the operator's
 * own user, sees the whole host filesystem, inherits the host environment
 * — `~/.ssh`, `~/.aws`, the shell's exported tokens, the OTLP export
 * credentials — and is bounded by nothing but the host's own limits. Every flag
 * in `hardening.ts` is inert here. An agent that goes wrong in a container
 * wrecks a container; an agent that goes wrong in this mode wrecks the machine
 * the orchestrator runs on. It exists to debug a harness change without a
 * five-minute image build, and `SandboxKind` records `local` on the row so that
 * an unisolated run can never be mistaken for a sandboxed one afterwards.
 *
 * **What it does honour, it honours exactly.** The same spec goes in and the
 * same result comes out: the identity variables, the event-log directory, the
 * working directory, streamed output, the exit code, the wall clock, the
 * timeout, and a child that dies with the scope on interruption. Mounts are
 * translated rather than ignored — a container path in the spec is rewritten to
 * the host path the mount pointed at, so `EVENT_LOG_DIR=/run/events` and
 * `CLAUDE_CONFIG_DIR=/run/agent-home/claude` land in the run's real directories
 * and the `atm.turn` rows the harness writes are found where the orchestrator
 * looks for them.
 *
 * **What it cannot honour, it names.** A read-only bind is not enforceable
 * without a mount namespace, a memory cap is not enforceable without a cgroup,
 * and pretending otherwise is the one thing that would make this mode dangerous
 * rather than merely unsafe. {@link unhonouredBy} is pure and lists every
 * guarantee the spec asked for that this mode drops on the floor, and `run`
 * logs that list once per run, so the difference is in the operator's log rather
 * than in their assumptions.
 *
 * Peak memory and the OOM flag are never fabricated: there is no kernel verdict
 * to read, so `peakMemoryBytes` is null and `oomKilled` is false — meaning "no
 * verdict", which is readable only together with `kind: "local"`.
 *
 * It leaves the same `atm.sandbox` row a container does, through the same
 * combinator. That is not symmetry for its own sake: a run served without
 * isolation is exactly the run someone will want to find later, and a mode that
 * quietly wrote no row would be the one mode invisible to the query that goes
 * looking. The row says `kind: "local"`, `teardown: "skipped"`, and null where
 * there was no kernel to ask.
 */

import { join } from "node:path";
import * as BunChildProcessSpawner from "@effect/platform-bun/BunChildProcessSpawner";
import * as BunFileSystem from "@effect/platform-bun/BunFileSystem";
import * as BunPath from "@effect/platform-bun/BunPath";
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
  type Ref,
  Result,
  Stream,
} from "effect";
import { FileSystem } from "effect/FileSystem";
import * as ChildProcess from "effect/unstable/process/ChildProcess";
import {
  type ChildProcessHandle,
  ChildProcessSpawner,
} from "effect/unstable/process/ChildProcessSpawner";
// The environment contract is the container's, imported rather than restated:
// the two implementations set the same names in the same precedence, and the
// only difference between them is that a container path is a host path here.
import {
  CONTAINER_LOG_ENV,
  EVENT_LOG_DIR_ENV_VAR,
  EXPORT_ENV_PREFIX,
} from "./docker-argv";
import {
  ContainerStartFailed,
  MountSourceMissing,
  SandboxTimedOut,
} from "./errors";
import { eventLogDirOf, type Mount, mountSourcePaths } from "./mounts";
import {
  makeSandboxProgress,
  observeSandboxProgress,
  type SandboxProgress,
  withSandboxEvent,
} from "./sandbox-event";
import {
  identityEnv,
  type OutputStream,
  Sandbox,
  type SandboxResult,
  type SandboxRunInput,
  type SandboxSpec,
} from "./spec";

/**
 * The confinements a spec can ask for, as names a log line can carry. Every one
 * of them is a property of a container rather than of a process, which is why
 * this list exists at all: the operator running in this mode should be able to
 * read what they gave up without reading this file.
 */
export const LOCAL_GUARANTEES = [
  "capabilities",
  "cpu",
  "env_isolation",
  "filesystem_confinement",
  "memory",
  "network",
  "no_new_privileges",
  "pids",
  "read_only_mounts",
  "read_only_rootfs",
  "tmpfs",
  "user",
] as const;

/** One confinement a spec asked for. */
export type LocalGuarantee = (typeof LOCAL_GUARANTEES)[number];

/**
 * Everything the spec asked for that a host process cannot deliver. Pure, so
 * the honesty is unit-testable rather than a comment.
 *
 * The unconditional ones are the ones that matter: the child runs as the
 * operator, reads every file the operator can read, inherits the operator's
 * environment, shares the host's network stack, and answers to no limit on
 * memory, cpu or processes. The rest are listed only when the spec actually
 * asked for them, so a caller that asked for nothing is not told it lost
 * something.
 *
 * The record is keyed by the whole union, so a guarantee added to
 * {@link LOCAL_GUARANTEES} is a compile error here rather than a confinement
 * that silently stops being reported.
 */
export const unhonouredBy = (spec: SandboxSpec): readonly LocalGuarantee[] => {
  const { hardening, mounts } = spec;
  const dropped = {
    capabilities: hardening.capDrop.length > 0,
    cpu: true,
    env_isolation: true,
    filesystem_confinement: true,
    memory: true,
    network: true,
    no_new_privileges: hardening.noNewPrivileges,
    pids: true,
    read_only_mounts: mounts.some((mount) => mount.readOnly),
    read_only_rootfs: hardening.readOnlyRootfs,
    tmpfs: hardening.tmpfs.length > 0,
    user: true,
  } as const satisfies Record<LocalGuarantee, boolean>;
  return LOCAL_GUARANTEES.filter((guarantee) => dropped[guarantee]);
};

/** A path inside the container, and the mounts that decide where it really is. */
export interface HostPathInput {
  readonly containerPath: string;
  readonly mounts: readonly Mount[];
}

/**
 * The host path a container path resolves to through the mount table, or null
 * when no mount covers it.
 *
 * Longest prefix wins, and the prefix has to end on a segment boundary:
 * `/artifacts` must not capture `/artifacts-scratch`, and `/artifacts/task`
 * must beat `/artifacts` for a path under it. That is the whole of the
 * translation, and it is why a mount set built by `mountsFor` behaves the same
 * in both modes.
 */
export const hostPathOf = ({ containerPath, mounts }: HostPathInput) => {
  const [matched] = mounts
    .filter(
      (mount) =>
        containerPath === mount.containerPath ||
        containerPath.startsWith(`${mount.containerPath}/`)
    )
    .sort((a, b) => b.containerPath.length - a.containerPath.length);
  return matched === undefined
    ? null
    : join(matched.hostPath, containerPath.slice(matched.containerPath.length));
};

/**
 * One environment value, translated where it names a mounted path. Only a whole
 * absolute value is rewritten — a colon-separated list or a path embedded in a
 * sentence is left alone, because guessing at the structure of a value is how a
 * `PATH` gets mangled.
 */
const translatedValue = (mounts: readonly Mount[], value: string) =>
  value.startsWith("/")
    ? (hostPathOf({ containerPath: value, mounts }) ?? value)
    : value;

/** The host directory the run mount points at, or null where the spec has none. */
const runDirOf = (mounts: readonly Mount[]) =>
  mounts.find((mount) => mount.purpose === "run")?.hostPath ?? null;

/**
 * The command's working directory on the host: the spec's container-side
 * working directory, translated.
 *
 * An untranslatable path is passed through rather than substituted. The spawn
 * then fails with the path in the message, which is the failure an operator can
 * act on; quietly running in some other directory is the one that produces a
 * run whose output is nowhere.
 */
export const localWorkingDir = (spec: SandboxSpec) =>
  hostPathOf({ containerPath: spec.workingDir, mounts: spec.mounts }) ??
  spec.workingDir;

/**
 * The environment the child is started with, in the container's own precedence
 * order: the log defaults, then the caller's settings, then the correlation
 * ids, then the ledger directory. The last two win for the same reasons they
 * win in a container — a caller cannot overwrite the ids its own row joins on,
 * and it cannot redirect the ledger away from the run's directory, which is
 * where the orchestrator reads the `atm.turn` rows back from.
 *
 * The one difference from `containerEnv` is the translation: every absolute
 * value that names a mounted path is rewritten to the host path behind it, so
 * `CLAUDE_CONFIG_DIR=/run/agent-home/claude` in a spec written for docker
 * reaches the child as the run's real agent home.
 *
 * The caller's `OTEL_*` variables are dropped here exactly as they are for a
 * container. The host's own copies are unset separately at the spawn, because
 * this mode inherits the host environment — see `env_isolation` in
 * {@link unhonouredBy}.
 */
export const localEnv = (
  spec: SandboxSpec
): Readonly<Record<string, string>> => {
  const translated = Object.fromEntries(
    Object.entries(spec.env)
      .filter(([name]) => !name.startsWith(EXPORT_ENV_PREFIX))
      .map(([name, value]) => [name, translatedValue(spec.mounts, value)])
  );
  const runDir = runDirOf(spec.mounts);
  const ledger: Readonly<Record<string, string>> =
    runDir === null ? {} : { [EVENT_LOG_DIR_ENV_VAR]: eventLogDirOf(runDir) };
  return {
    ...CONTAINER_LOG_ENV,
    ...translated,
    ...identityEnv(spec.identity),
    ...ledger,
  };
};

/**
 * The host's own export credentials, as variables to unset. A container never
 * sees them because it starts from an empty environment; this mode starts from
 * the operator's, so the one secret the whole design keeps outside the sandbox
 * has to be removed by name. Pure over whatever environment it is handed.
 */
export const unsetExportEnv = (
  hostEnv: Readonly<Record<string, string | undefined>>
): Readonly<Record<string, undefined>> =>
  Object.fromEntries(
    Object.keys(hostEnv)
      .filter((name) => name.startsWith(EXPORT_ENV_PREFIX))
      .map((name) => [name, undefined])
  );

/**
 * The mount sources, checked before anything is spawned. Docker refuses to
 * start a container whose bind source is missing; nothing refuses anything
 * here, so the check has to be explicit or a typo'd artifacts path becomes a
 * run that writes where nobody will look.
 *
 * A path that cannot be stat'd counts as missing: an unreadable mount source is
 * as unusable as an absent one, and the error names which purpose it was.
 */
const checkMountSources = (fs: FileSystem, mounts: readonly Mount[]) =>
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

/** One of the child's two pipes, decoded and tagged with which one it is. */
const tagged = (bytes: ChildProcessHandle["stdout"], stream: OutputStream) =>
  bytes.pipe(
    Stream.decodeText(),
    Stream.map((text) => ({ stream, text })),
    // A pipe from a process we spawned ourselves failing to read is not a
    // condition the sandbox vocabulary has a name for, and inventing one would
    // put a wrong class on a ledger row. It surfaces as a defect instead.
    Stream.orDie
  );

/**
 * Both pipes into the consumer, interleaved as they arrive. The consumer's
 * effect gates the reader, so a slow consumer slows the child rather than
 * filling a buffer nobody bounded — the same back-pressure the container mode
 * gives.
 */
const drainOutput = <E, R>(
  child: ChildProcessHandle,
  onOutput: SandboxRunInput<E, R>["onOutput"]
) =>
  Stream.merge(
    tagged(child.stdout, "stdout"),
    tagged(child.stderr, "stderr")
  ).pipe(Stream.runForEach(onOutput));

/**
 * A spawn that never happened. The image is carried through unchanged even
 * though no image was involved, because it is the tag the same spec would have
 * used under docker and losing it would make the two modes' rows
 * incomparable.
 */
const startFailed = (spec: SandboxSpec, cause: unknown) =>
  new ContainerStartFailed({
    exitCode: null,
    image: spec.image,
    stderr: clipError(String(cause)),
  });

/** The one line that says this run had no isolation, and exactly what it lost. */
const warnUnisolated = (spec: SandboxSpec) =>
  Effect.logWarning("local sandbox: the run has no container isolation").pipe(
    Effect.annotateLogs({
      guarantees: unhonouredBy(spec).join(","),
      kind: "local",
      runId: spec.identity.runId,
    })
  );

/** Applies the spec's wall-clock cap, where it set one. */
const withTimeout =
  (timeoutMs: number | null) =>
  <A, E, R>(effect: Effect.Effect<A, E, R>) =>
    timeoutMs === null
      ? effect
      : effect.pipe(
          Effect.timeoutOrElse({
            duration: Duration.millis(timeoutMs),
            // The child dies with the scope, so the cap is enforced by the
            // interrupt this failure causes rather than by a signal sent here.
            orElse: () => Effect.fail(new SandboxTimedOut({ timeoutMs })),
          })
        );

/** What the child is invoked as, once the spec's container paths are host paths. */
const commandOf = (spec: SandboxSpec) =>
  ChildProcess.make(spec.command, [...spec.args], {
    cwd: localWorkingDir(spec),
    env: { ...unsetExportEnv(process.env), ...localEnv(spec) },
    // The host's `PATH` is what resolves the binary: there is no image to
    // resolve it against. Everything else the host exports rides along with it,
    // which is `env_isolation` in the unhonoured list — minus the export
    // credentials above, which do not cross into a sandbox in either mode.
    extendEnv: true,
  });

/** The kind every result and every row from this module carries. */
const KIND = "local";

/** The dependencies captured once when the layer is built, so `run` needs none. */
interface LocalDeps {
  readonly fs: FileSystem;
  readonly spawner: ChildProcessSpawner["Service"];
  /**
   * Held rather than required, for the same reason the docker implementation
   * holds it: `SandboxInterface` promises a run needs nothing the caller did not
   * already have, and a `Telemetry` in the run's requirements would make every
   * caller provide the emitter for a row it does not know exists.
   */
  readonly telemetry: TelemetryInterface;
}

/** Everything one child needs, plus the cell its facts are folded into. */
interface LocalAttemptInput<E, R> {
  readonly deps: LocalDeps;
  readonly onOutput: SandboxRunInput<E, R>["onOutput"];
  readonly progress: Ref.Ref<SandboxProgress>;
  readonly spec: SandboxSpec;
}

/**
 * One local run: check the mounts, say what is not isolated, spawn, stream,
 * wait, and report.
 *
 * The scope is the teardown. Nothing here kills the child by hand — the
 * spawner's own finalizer kills the process group when the scope closes, which
 * covers the timeout, an interrupt from a stop command, and a consumer that
 * failed, all on one path.
 */
const attempt = <E, R>({
  deps,
  onOutput,
  progress,
  spec,
}: LocalAttemptInput<E, R>) =>
  Effect.gen(function* () {
    // There is no container, so there never was one to remove. `skipped` is
    // true from the first instant rather than at the end, which is what lets a
    // run that failed on its mounts still report a truthful teardown.
    yield* observeSandboxProgress(progress, { teardown: "skipped" });
    yield* checkMountSources(deps.fs, spec.mounts);
    yield* warnUnisolated(spec);
    const startedAtMs = yield* Clock.currentTimeMillis;

    const exitCode = yield* Effect.gen(function* () {
      const child = yield* deps.spawner
        .spawn(commandOf(spec))
        .pipe(Effect.mapError((cause) => startFailed(spec, cause)));
      yield* drainOutput(child, onOutput);
      // A child killed by a signal produces no code of its own, and the
      // platform reports that as a failure rather than a number. Null is what
      // the result means by "there was no exit code", so it is not invented
      // here either.
      const ended = yield* Effect.result(child.exitCode);
      return Result.isSuccess(ended) ? ended.success : null;
    }).pipe(withTimeout(spec.timeoutMs), Effect.scoped);

    const endedAtMs = yield* Clock.currentTimeMillis;
    yield* observeSandboxProgress(progress, { exitCode });
    return {
      // No container existed, so there is no id to report and nothing to
      // remove; `kind` is what tells a reader why.
      containerId: null,
      exitCode,
      image: spec.image,
      imagePulled: false,
      kind: KIND,
      mountCount: spec.mounts.length,
      // No cgroup, so no kernel verdict: false here means "not observed",
      // which is readable only beside `kind: "local"`.
      oomKilled: false,
      peakMemoryBytes: null,
      teardown: "skipped",
      wallClockMs: endedAtMs - startedAtMs,
    } satisfies SandboxResult;
  });

/**
 * The same one-row-per-run guarantee the container mode gives, over the same
 * combinator and the same accumulator — so a `GROUP BY kind` over the ledger is
 * a real comparison rather than a count of the runs that happened to be
 * instrumented.
 */
const runLocal =
  (deps: LocalDeps) =>
  <E, R>({ onOutput, spec }: SandboxRunInput<E, R>) =>
    Effect.gen(function* () {
      const progress = yield* makeSandboxProgress;
      return yield* attempt({ deps, onOutput, progress, spec }).pipe(
        withSandboxEvent({ kind: KIND, progress, spec }),
        Effect.provideService(Telemetry, deps.telemetry)
      );
    });

/**
 * Bun's process spawner and the two services it is built from. Named
 * explicitly rather than taken from the aggregate platform layer, which would
 * also construct a terminal and claim the host's stdin.
 */
const platformLayer = Layer.mergeAll(
  BunChildProcessSpawner.layer.pipe(
    Layer.provide(Layer.mergeAll(BunFileSystem.layer, BunPath.layer))
  ),
  BunFileSystem.layer
);

/** The local sandbox as an effect, for a caller that already has the services. */
export const localSandbox = Effect.gen(function* () {
  const fs = yield* FileSystem;
  const spawner = yield* ChildProcessSpawner;
  const telemetry = yield* Telemetry;
  // No daemon, no containers, nothing to sweep. Empty rather than unsupported:
  // a caller sweeping at boot should not have to ask which mode it is in.
  return Sandbox.of({
    held: Effect.succeed([]),
    remove: () => Effect.void,
    run: runLocal({ fs, spawner, telemetry }),
  });
});

/**
 * The escape hatch, wired as the {@link Sandbox} service. Swapping this layer
 * for the docker one is the whole of "run this without a container" — nothing
 * above the seam changes, and the `local` on every row it produces is what
 * keeps the two apart afterwards.
 */
export const localSandboxLayer = Layer.effect(Sandbox, localSandbox).pipe(
  Layer.provide(platformLayer)
);
