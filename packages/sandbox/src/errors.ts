/**
 * How a container can fail, and how docker's own noise is given a name.
 *
 * Two vocabularies, deliberately different sizes, the same split the harness
 * makes. The error classes are what a failure *is* — nine of them, because "the
 * daemon is not running" and "the kernel killed it for memory" want completely
 * different reactions from the orchestrator: the first pauses dispatch, the
 * second retries the task on a smaller concurrency. The outcomes are how a
 * container *ended* — six, because that is what a `GROUP BY` over the ledger
 * should have to read.
 *
 * A non-zero exit code is not in here. A container whose command exits 1 ran
 * exactly as asked; the exit code is data on the result, and turning it into a
 * failure would make an agent's failing test suite indistinguishable from a
 * daemon that is down.
 *
 * Two outcomes exist that the base vocabulary does not have. `oom_killed`
 * because a container the kernel killed is a capacity fact and folding it into
 * `errored` is how a host that is too small stops being visible. `start_failed`
 * because a run that never started did no work at all — it consumed no tokens
 * and produced no transcript, and counting it beside runs that actually ran
 * makes every rate over the ledger wrong.
 *
 * {@link classifySandboxFailure} is pure over what docker actually hands back —
 * an exit code, an inspect flag, a stderr blob, or a thrown value — so the
 * classification is testable without a daemon, and it is the only place a
 * daemon's message is read for meaning.
 */

import { clipError } from "@workspace/telemetry";
import { Schema } from "effect";
import { MountPurpose } from "./mounts";

/**
 * The names a failure can carry onto an event: the class names of the errors
 * below plus `Unknown`, which is what the classifier answers when it genuinely
 * cannot tell. A wrong guess is worse than an admission — it sends the
 * orchestrator down a recovery path built for a different failure.
 */
export const SANDBOX_ERROR_CLASSES = [
  "CloneFailed",
  "ContainerStartFailed",
  "DaemonUnreachable",
  "ImageMissing",
  "MountSourceMissing",
  "OomKilled",
  "TeardownFailed",
  "TimedOut",
  "Unknown",
] as const;

/** The classification of a container failure, as it lands on an event. */
export const SandboxErrorClass = Schema.Literals(SANDBOX_ERROR_CLASSES);
export type SandboxErrorClass = typeof SandboxErrorClass.Type;

/**
 * The literals `atm.sandbox` adds to the shared outcome union. Pass this to
 * `outcomeField` so the event's outcome column stays exhaustive by
 * construction.
 */
export const SANDBOX_EXTRA_OUTCOMES = ["oom_killed", "start_failed"] as const;

/** How a container ended. */
export const SandboxOutcome = Schema.Literals([
  "done",
  "errored",
  "interrupted",
  "timeout",
  ...SANDBOX_EXTRA_OUTCOMES,
]);
export type SandboxOutcome = typeof SandboxOutcome.Type;

/**
 * The docker daemon could not be reached: not running, socket permissions, a
 * remote host that is down. Never the run's fault, which is why it pauses
 * dispatch rather than failing one task — every other run is about to hit it
 * too.
 */
export class DaemonUnreachable extends Schema.TaggedErrorClass<DaemonUnreachable>()(
  "Sandbox.DaemonUnreachable",
  { detail: Schema.String }
) {}

/**
 * The image is not on the host and could not be pulled. Its own class because
 * the fix is a build, not a retry: the image build is a scheduled host job and
 * a run that waits for it will wait forever.
 */
export class ImageMissing extends Schema.TaggedErrorClass<ImageMissing>()(
  "Sandbox.ImageMissing",
  { detail: Schema.String, image: Schema.String }
) {}

/**
 * A host path a mount points at does not exist. Raised before `docker run`
 * where the check is cheap, because `--mount` fails with a message about an
 * "invalid mount config" that says nothing about which of five paths was wrong.
 */
export class MountSourceMissing extends Schema.TaggedErrorClass<MountSourceMissing>()(
  "Sandbox.MountSourceMissing",
  { hostPath: Schema.String, purpose: MountPurpose }
) {}

/**
 * The container was created but never got as far as running the command: a bad
 * entrypoint, an OCI runtime refusal, a limit the host cannot satisfy. Distinct
 * from a command that ran and exited non-zero, which is not a failure at all.
 */
export class ContainerStartFailed extends Schema.TaggedErrorClass<ContainerStartFailed>()(
  "Sandbox.ContainerStartFailed",
  {
    exitCode: Schema.NullOr(Schema.Int),
    image: Schema.String,
    stderr: Schema.String,
  }
) {}

/**
 * The kernel killed the container for exceeding its memory limit. `limitMb` is
 * on the error because the answer is either a bigger limit or a lower
 * concurrency cap, and neither is decidable without knowing which limit was hit.
 */
export class OomKilled extends Schema.TaggedErrorClass<OomKilled>()(
  "Sandbox.OomKilled",
  { containerId: Schema.NullOr(Schema.String), limitMb: Schema.Number }
) {}

/** The container outlived its cap. The cap is named so the ledger says which one. */
export class SandboxTimedOut extends Schema.TaggedErrorClass<SandboxTimedOut>()(
  "Sandbox.TimedOut",
  { timeoutMs: Schema.Number }
) {}

/**
 * The container could not be removed. Almost never the run's outcome — the work
 * already succeeded or failed on its own terms — but it is a real leak of disk
 * and of a mounted credential copy, so it is an error someone can count rather
 * than a swallowed log line.
 */
export class TeardownFailed extends Schema.TaggedErrorClass<TeardownFailed>()(
  "Sandbox.TeardownFailed",
  { cause: Schema.Unknown, containerId: Schema.NullOr(Schema.String) }
) {}

/**
 * Materializing the run's checkout failed: the mirror is missing, the reference
 * clone refused, the base ref does not exist. Raised on the host, before any
 * container exists.
 */
export class CloneFailed extends Schema.TaggedErrorClass<CloneFailed>()(
  "Sandbox.CloneFailed",
  {
    exitCode: Schema.NullOr(Schema.Int),
    repo: Schema.String,
    stderr: Schema.String,
  }
) {}

/** Everything a sandbox operation can fail with. The failure channel of a run. */
export type SandboxError =
  | CloneFailed
  | ContainerStartFailed
  | DaemonUnreachable
  | ImageMissing
  | MountSourceMissing
  | OomKilled
  | SandboxTimedOut
  | TeardownFailed;

/**
 * Tag to class name. Written out rather than derived by stripping the prefix,
 * so a renamed tag is a compile error here instead of a silently new value in
 * the ledger.
 */
const CLASS_OF_TAG = {
  "Sandbox.CloneFailed": "CloneFailed",
  "Sandbox.ContainerStartFailed": "ContainerStartFailed",
  "Sandbox.DaemonUnreachable": "DaemonUnreachable",
  "Sandbox.ImageMissing": "ImageMissing",
  "Sandbox.MountSourceMissing": "MountSourceMissing",
  "Sandbox.OomKilled": "OomKilled",
  "Sandbox.TeardownFailed": "TeardownFailed",
  "Sandbox.TimedOut": "TimedOut",
} as const satisfies Record<SandboxError["_tag"], SandboxErrorClass>;

/** The classification of a typed sandbox failure. */
export const errorClassOf = (error: SandboxError) => CLASS_OF_TAG[error._tag];

/**
 * Classification to outcome. Everything that happened before the command ran is
 * `start_failed`, because none of those runs did any work; the kernel kill gets
 * its own literal; a failed teardown reports the run it followed, not itself,
 * so it maps to `errored` only when it is the sole failure in hand.
 */
const OUTCOME_OF_CLASS = {
  CloneFailed: "start_failed",
  ContainerStartFailed: "start_failed",
  DaemonUnreachable: "start_failed",
  ImageMissing: "start_failed",
  MountSourceMissing: "start_failed",
  OomKilled: "oom_killed",
  TeardownFailed: "errored",
  TimedOut: "timeout",
  Unknown: "errored",
} as const satisfies Record<SandboxErrorClass, SandboxOutcome>;

/** How a container ends given what went wrong. Total over the classification union. */
export const outcomeOfClass = (errorClass: SandboxErrorClass) =>
  OUTCOME_OF_CLASS[errorClass];

/** The human-readable half of a typed failure, before sanitizing. */
const messageOf = (error: SandboxError): string => {
  switch (error._tag) {
    case "Sandbox.CloneFailed":
      return error.stderr.trim() || `clone of ${error.repo} failed`;
    case "Sandbox.ContainerStartFailed":
      return error.stderr.trim() || `${error.image} did not start`;
    case "Sandbox.DaemonUnreachable":
      return error.detail;
    case "Sandbox.ImageMissing":
      return error.detail.trim() || `no image ${error.image}`;
    case "Sandbox.MountSourceMissing":
      return `no ${error.purpose} mount source at ${error.hostPath}`;
    case "Sandbox.OomKilled":
      return `killed by the kernel at the ${error.limitMb}MB limit`;
    case "Sandbox.TeardownFailed":
      return `container ${error.containerId ?? "unknown"} not removed`;
    default:
      return `exceeded the ${error.timeoutMs}ms cap`;
  }
};

/**
 * The three fields a failure puts on an event, from the one place that holds
 * the tag. The message goes through the shared sanitizer here rather than at the
 * emit site, because the text is a daemon's and a daemon echoes back the argv,
 * the registry auth header and the environment it was handed.
 */
export const describeError = (error: SandboxError) => {
  const errorClass = errorClassOf(error);
  return {
    errorClass,
    errorMessage: clipError(messageOf(error)),
    outcome: outcomeOfClass(errorClass),
  } as const;
};

/**
 * Docker's own exit codes, which overlap with the command's and therefore have
 * to be read together with stderr. 125 is the daemon refusing the run itself,
 * 126 and 127 are the container starting and finding nothing to execute, and
 * 137 is a SIGKILL — which the kernel's OOM killer sends, and so does every
 * `docker kill` a teardown performs. That ambiguity is why the inspect flag
 * outranks the code below.
 */
export const DOCKER_EXIT_CODES = {
  /** `docker run` itself failed: a bad flag, a bad mount, an unreachable daemon. */
  daemonError: 125,
  /** The command was found but could not be invoked. */
  notExecutable: 126,
  /** The command does not exist in the image. */
  notFound: 127,
  /** SIGKILL. The OOM killer, or a teardown that escalated. */
  sigkill: 137,
  /** SIGTERM. An ordinary stop. */
  sigterm: 143,
} as const;

/**
 * Anchors per class, in the order they are tried. The order is the
 * classification: a daemon that is down produces a message that also mentions
 * the image it was asked for, and reading that as a missing image would send a
 * healthy queue into an image rebuild.
 */
const ANCHORS: readonly (readonly [SandboxErrorClass, readonly string[]])[] = [
  [
    "DaemonUnreachable",
    [
      "cannot connect to the docker daemon",
      "docker daemon is not running",
      "dial unix /var/run/docker.sock",
      "is the docker daemon running",
      "permission denied while trying to connect",
    ],
  ],
  [
    "MountSourceMissing",
    [
      "are you trying to mount a directory onto a file",
      "bind source path does not exist",
      "invalid mount config",
    ],
  ],
  [
    "ImageMissing",
    [
      "manifest unknown",
      "no such image",
      "not found: manifest",
      "pull access denied",
      "repository does not exist",
      "unable to find image",
    ],
  ],
  ["OomKilled", ["out of memory", "oomkilled", "memory cgroup out of memory"]],
  ["TimedOut", ["deadline exceeded", "timed out", "timeout"]],
  [
    "ContainerStartFailed",
    [
      "cannot start container",
      "executable file not found",
      "failed to create task",
      "no such file or directory: unknown",
      "oci runtime create failed",
      "starting container process caused",
    ],
  ],
  [
    "CloneFailed",
    [
      "could not read from remote repository",
      "does not appear to be a git repository",
      "fatal: repository",
      "not a valid object name",
      "reference is not a tree",
    ],
  ],
];

/** The text a thrown value carries, whatever shape it arrived in. */
const textOfThrown = (thrown: unknown) => {
  if (typeof thrown === "string") {
    return thrown;
  }
  if (thrown instanceof Error) {
    return `${thrown.name} ${thrown.message}`;
  }
  const message = (thrown as { readonly message?: unknown } | null)?.message;
  return typeof message === "string" ? message : "";
};

/** The class of a thrown value, when it is one of ours. */
const classOfThrown = (thrown: unknown) => {
  const tag = (thrown as { readonly _tag?: unknown } | null)?._tag;
  return typeof tag === "string" && tag in CLASS_OF_TAG
    ? CLASS_OF_TAG[tag as SandboxError["_tag"]]
    : null;
};

/**
 * How much of a container's stderr is kept for classification. The tail rather
 * than the head, for the same reason the harness keeps the tail: a build or a
 * pull prints its progress first and its reason last, so a bounded buffer that
 * keeps the beginning classifies every failure as `Unknown`.
 */
export const STDERR_TAIL_CHARS = 4096;

/** The last {@link STDERR_TAIL_CHARS} characters of whatever has been read so far. */
export const keepStderrTail = (text: string) =>
  text.length > STDERR_TAIL_CHARS ? text.slice(-STDERR_TAIL_CHARS) : text;

/** What a failed container hands the classifier: any or all of it may be absent. */
export interface SandboxFailureShape {
  /** The container's exit code, or null when it never produced one. */
  readonly exitCode?: number | null;
  /** `State.OOMKilled` from `docker inspect`. Outranks the exit code, which lies. */
  readonly oomKilled?: boolean;
  /** Whatever docker or the container wrote to stderr, raw. */
  readonly stderr?: string | null;
  /** Whatever was thrown or failed with — one of ours, an `Error`, or anything. */
  readonly thrown?: unknown;
}

/**
 * Names a container failure from a typed error, a stderr blob, an exit code and
 * the inspect flag, in that order of authority. Pure and case-insensitive.
 *
 * The inspect flag is checked before the text because 137 is a SIGKILL and both
 * the OOM killer and an ordinary teardown send one — the flag is the only thing
 * that tells them apart, and guessing from the code alone reports phantom
 * memory pressure on every stopped run.
 *
 * Conservative on purpose: a miss costs a vaguer ledger row, a wrong match
 * costs a paused queue or a rebuild of an image that was fine.
 */
export const classifySandboxFailure = ({
  exitCode,
  oomKilled,
  stderr,
  thrown,
}: SandboxFailureShape): SandboxErrorClass => {
  const typed = classOfThrown(thrown);
  if (typed !== null) {
    return typed;
  }
  if (oomKilled === true) {
    return "OomKilled";
  }
  const text = `${textOfThrown(thrown)} ${stderr ?? ""}`.toLowerCase().trim();
  for (const [errorClass, anchors] of ANCHORS) {
    if (anchors.some((anchor) => text.includes(anchor))) {
      return errorClass;
    }
  }
  // Only the codes docker mints for itself. A command that exited 1 ran fine as
  // far as the sandbox is concerned, and calling that a sandbox failure would
  // report every failing test suite as broken infrastructure.
  if (
    exitCode === DOCKER_EXIT_CODES.daemonError ||
    exitCode === DOCKER_EXIT_CODES.notExecutable ||
    exitCode === DOCKER_EXIT_CODES.notFound
  ) {
    return "ContainerStartFailed";
  }
  return "Unknown";
};
