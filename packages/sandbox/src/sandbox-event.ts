/**
 * The `atm.sandbox` wide event: one row per container, and the span naming rule
 * every subprocess in this package goes through.
 *
 * A container is the unit of work this package owns — one image, one command,
 * one lifetime. The questions asked of it afterwards are capacity questions and
 * they are all `GROUP BY`s over columns that have to already exist: how much of
 * the p99 is a cold image pull, which runs the kernel killed and at what limit,
 * whether the containers that failed had more mounts than the ones that did
 * not, and whether anything ever went out unisolated.
 *
 * Three properties are load-bearing, and this file enforces each rather than
 * documenting it.
 *
 * One row per container on every exit path. The emit goes through
 * {@link withSandboxEvent} onto the telemetry package's `withWideEvent` — a
 * failure, a defect and an interrupt each leave a row, and the interrupt is the
 * common case, because interrupting the fiber is how a run is stopped. Nothing
 * here hand-rolls an emit.
 *
 * A non-zero exit code is not a failure. A container whose command exits 1 ran
 * exactly as asked: the outcome is `done` and the code is a field. Folding it
 * into `errored` makes an agent's failing test suite indistinguishable from a
 * daemon that is down, which is the distinction this row exists to keep.
 *
 * A subprocess span is labelled by its subcommand and never by its argv. A
 * `git`, `gh` or `docker` command line carries a clone URL with a token in it,
 * a registry credential, or the whole environment — unbounded, and a secret
 * waiting to be exported. {@link subprocessSpanName} is the single
 * implementation of that rule, so the docker and repo modules obey it by
 * calling it rather than by remembering it.
 *
 * This code runs on the host, inside the orchestrator process, never inside a
 * container — which is what makes the counter at the bottom legal: a `Metric`
 * needs a process that outlives its export interval, and the loop is one.
 */

import {
  BASE_OUTCOMES,
  boundedCounter,
  clipError,
  defineEvent,
  outcomeField,
  SanitizedText,
  type WideEventContext,
  withWideEvent,
} from "@workspace/telemetry";
import { Cause, Effect, type Exit, Option, Ref, Schema } from "effect";
import {
  classifySandboxFailure,
  describeError,
  outcomeOfClass,
  SANDBOX_ERROR_CLASSES,
  SANDBOX_EXTRA_OUTCOMES,
  type SandboxError,
  type SandboxErrorClass,
  type SandboxOutcome,
} from "./errors";
import { defaultHardening, type HardeningSpec } from "./hardening";
import {
  SANDBOX_KINDS,
  SandboxKind,
  type SandboxResult,
  type SandboxSpec,
  TEARDOWN_OUTCOMES,
  TeardownOutcome,
} from "./spec";

/** The filter key every query over containers starts from. */
export const SANDBOX_EVENT_MARKER = "atm.sandbox";

/**
 * The span one container run gets. Lowercase `noun.verb`, the convention for an
 * infrastructure wrapper — the identifying ids ride as attributes, because a
 * span name with a run id in it is a name no backend can aggregate.
 */
export const SANDBOX_RUN_SPAN = "sandbox.run";

/**
 * Longest token accepted as a subcommand. A subcommand is a word; a 40-char hex
 * string is an object id, a token, or a branch name, and the cap keeps those out.
 */
export const MAX_SUBCOMMAND_CHARS = 24;

/** A word: lowercase, no separators, no path or URL punctuation. */
const SUBCOMMAND_WORD = /^[a-z][a-z0-9-]*$/;

/** A flag that swallows the next token. `--flag=value` carries its own; `-C` does not. */
const takesValue = (token: string) =>
  token.startsWith("-") && !token.includes("=");

/**
 * The subcommand of an argv, or null where there is not one worth naming.
 *
 * The rule is deliberately narrow, because the two mistakes do not cost the
 * same: a missed subcommand costs a span called `git.exec`, while a wrong one
 * puts a clone URL, a branch name or a bearer token into a span name that is
 * exported, indexed and kept. So a candidate is the first bare word no flag
 * claimed, and it has to look like a word — which a path, a URL, a `key=value`
 * and every token shape do not.
 */
export const subcommandOf = (args: readonly string[]) => {
  let claimed = false;
  for (const token of args) {
    if (token.startsWith("-")) {
      claimed = takesValue(token);
      continue;
    }
    if (claimed) {
      claimed = false;
      continue;
    }
    return token.length <= MAX_SUBCOMMAND_CHARS && SUBCOMMAND_WORD.test(token)
      ? token
      : null;
  }
  return null;
};

/** The executable's own name, with any directory it was invoked through dropped. */
const commandName = (command: string) => {
  const base = command.split("/").at(-1) ?? command;
  return SUBCOMMAND_WORD.test(base) ? base : "subprocess";
};

/**
 * The span name for one subprocess: `docker.run`, `git.clone`, `gh.pr`. Two
 * tiers and nothing else — no arguments, no paths, no URLs. `exec` is the
 * honest fallback where no subcommand could be read safely, naming the shape of
 * what happened rather than inventing a label out of a token.
 */
export const subprocessSpanName = (command: string, args: readonly string[]) =>
  `${commandName(command)}.${subcommandOf(args) ?? "exec"}`;

/**
 * Wraps one subprocess in a span named by its subcommand: the single
 * implementation of the argv rule. Every process this package spawns —
 * `docker`, `git`, `gh` — goes through here, so a new subprocess cannot quietly
 * ship a span carrying a command line.
 *
 * @example
 * ```ts
 * const clone = (args: readonly string[]) =>
 *   spawn("git", args).pipe(withSubprocessSpan("git", args));
 * ```
 */
export const withSubprocessSpan =
  (
    command: string,
    args: readonly string[],
    attributes: Readonly<Record<string, string | number | boolean>> = {}
  ) =>
  <A, E, R>(effect: Effect.Effect<A, E, R>) =>
    effect.pipe(
      Effect.withSpan(subprocessSpanName(command, args), {
        attributes: { ...attributes, argCount: args.length },
      })
    );

/** The profiles a container's confinement is reported under. */
export const HARDENING_PROFILES = ["default", "custom"] as const;

/** Whether a container got the standard confinement or a modified one. */
export type HardeningProfile = (typeof HARDENING_PROFILES)[number];

/**
 * A stable rendering of every hardening decision, in a fixed order. Field by
 * field rather than `JSON.stringify`, because key order is not a contract and a
 * reordered interface would silently report every run as `custom`.
 */
const fingerprint = (spec: HardeningSpec) =>
  [
    spec.capDrop.join("+"),
    spec.cpus,
    spec.init,
    spec.memoryMb,
    spec.memorySwapMb,
    spec.network,
    spec.noNewPrivileges,
    spec.pidsLimit,
    spec.readOnlyRootfs,
    spec.tmpfs
      .map((mount) => `${mount.path}:${mount.sizeMb}:${mount.mode}`)
      .join("+"),
    spec.user,
  ].join("|");

const DEFAULT_FINGERPRINT = fingerprint(defaultHardening);

/**
 * Whether a container ran under the default confinement. One field answering
 * "was this run hardened the way every other run was"; the individual limits
 * sit beside it on the row and say how a `custom` run differed.
 */
export const hardeningProfileOf = (spec: HardeningSpec): HardeningProfile =>
  fingerprint(spec) === DEFAULT_FINGERPRINT ? "default" : "custom";

/**
 * Whether the container ran as root. The uid half of `uid:gid`, read as a
 * boolean because that is the only question anyone asks of it — and an empty
 * user is root too, which is exactly the case a `!== "0:0"` check would miss.
 */
export const runsAsRoot = (user: string) => {
  const uid = user.trim().split(":")[0] ?? "";
  return uid === "" || uid === "0" || uid === "root";
};

/**
 * What an implementation learned about a container before it could produce a
 * {@link SandboxResult}.
 *
 * This exists for the failing paths. A run that finishes returns the whole
 * result and the row is built from that; a run that dies between `docker create`
 * and `docker wait` returns nothing at all, and without an accumulator its row
 * would say the container never existed — no id, no pull flag, no teardown, and
 * a leaked container nobody can find.
 *
 * `stderrTail` is fed to the classifier and never reaches a row: a daemon echoes
 * back argv, registry auth headers and the environment it was handed, so the
 * text is read for meaning and thrown away.
 */
export interface SandboxProgress {
  readonly containerId: string | null;
  readonly exitCode: number | null;
  readonly imagePulled: boolean;
  readonly oomKilled: boolean;
  readonly peakMemoryBytes: number | null;
  /** Classification input, never a field. Bound it with `keepStderrTail`. */
  readonly stderrTail: string | null;
  /** Null until a teardown was attempted, which is not the same as one that was skipped. */
  readonly teardown: TeardownOutcome | null;
}

/** A container that has not started yet. */
export const emptySandboxProgress: SandboxProgress = {
  containerId: null,
  exitCode: null,
  imagePulled: false,
  oomKilled: false,
  peakMemoryBytes: null,
  stderrTail: null,
  teardown: null,
};

/** A fresh accumulator for one container. */
export const makeSandboxProgress = Ref.make(emptySandboxProgress);

/**
 * Folds what an implementation just learned into the accumulator. One patch
 * rather than seven setters, because the facts arrive in clusters — create
 * yields an id and a pull flag, wait yields the code, the OOM flag and the peak
 * — and a setter per field is six more call sites to forget one of.
 */
export const observeSandboxProgress = (
  progress: Ref.Ref<SandboxProgress>,
  patch: Partial<SandboxProgress>
) => Ref.update(progress, (current) => ({ ...current, ...patch }));

/**
 * One container. The shared identity, economics, outcome and environment
 * vocabulary comes from the telemetry base; everything below it is a question
 * about the container that the base cannot answer.
 *
 * `outcome` widens the base union by `oom_killed` and `start_failed`, which are
 * the two endings that stop being visible the moment they are folded into
 * `errored`: the first is a capacity fact about the host, the second is a run
 * that did no work at all and would otherwise make every rate over the ledger
 * wrong.
 */
export const SandboxEvent = defineEvent(SANDBOX_EVENT_MARKER, {
  /** The daemon's id while the container existed, which is what joins to the daemon's own logs. */
  containerId: Schema.NullOr(SanitizedText),
  /** The container's own wall clock. The gap to `durationMs` is pull, create and teardown. */
  containerMs: Schema.NullOr(Schema.Number),
  cpuLimit: Schema.Number,
  /** Data, not a failure: a command that exits 1 ran exactly as asked. */
  exitCode: Schema.NullOr(Schema.Int),
  /** `default` when the confinement matched {@link defaultHardening}, `custom` otherwise. */
  hardeningProfile: Schema.Literals(HARDENING_PROFILES),
  /** The image that actually ran, kept against the one that was asked for. */
  image: SanitizedText,
  /** True when the daemon had to fetch the image. The cold-start half of a slow run. */
  imagePulled: Schema.Boolean,
  /** Which implementation served the run, so an unisolated one cannot be mistaken for a sandboxed one. */
  kind: SandboxKind,
  /** The limit in force, without which an `oom_killed` row cannot be acted on. */
  memoryLimitMb: Schema.Number,
  /** The mount set, counted. The paths stay off the row; the count is the question. */
  mountCount: Schema.Natural,
  networkMode: SanitizedText,
  /** The kernel's verdict, from `State.OOMKilled` — the only thing that tells a memory kill from a teardown's SIGKILL. */
  oomKilled: Schema.Boolean,
  outcome: outcomeField(SANDBOX_EXTRA_OUTCOMES),
  peakMemoryBytes: Schema.NullOr(Schema.Number),
  pidsLimit: Schema.Number,
  readOnlyRootfs: Schema.Boolean,
  /** The flag that must never be true on a dispatched run. A field so it is countable, not assumed. */
  runAsRoot: Schema.Boolean,
  /** Null where the run never got far enough to attempt one. */
  teardown: Schema.NullOr(TeardownOutcome),
  /** The cap in force, without which a `timeout` row does not say which cap was hit. */
  timeoutMs: Schema.NullOr(Schema.Number),
});

/** The row one container supplies, derived from the schema so it cannot drift. */
export type SandboxEventInput = Parameters<typeof SandboxEvent.encode>[0];

/** What the emit site knows about one container run. */
export interface SandboxContext {
  /** Which implementation is running this. */
  readonly kind: SandboxKind;
  /** The cell the implementation folds its facts into; read once, as the run exits. */
  readonly progress: Ref.Ref<SandboxProgress>;
  /** The container as it was asked for: image, mounts, confinement, identity, cap. */
  readonly spec: SandboxSpec;
}

/**
 * The tags of this package's own errors, derived from the class list rather than
 * written out again. It is the one place the `Sandbox.` prefix convention is
 * relied on, and it exists because `errors.ts` exports a union but no guard.
 */
const SANDBOX_ERROR_TAGS: ReadonlySet<string> = new Set(
  SANDBOX_ERROR_CLASSES.filter((name) => name !== "Unknown").map(
    (name) => `Sandbox.${name}`
  )
);

/** Whether a failure came from this package, and can therefore describe itself. */
const isSandboxError = (value: unknown): value is SandboxError => {
  const tag = (value as { readonly _tag?: unknown } | null)?._tag;
  return typeof tag === "string" && SANDBOX_ERROR_TAGS.has(tag);
};

/** The text a defect carries, before it is clipped. */
const defectMessage = (defect: unknown) =>
  defect instanceof Error ? defect.message : String(defect);

/** How the container ended, what to call the failure behind it, and the result if there is one. */
interface SandboxEnding {
  readonly errorClass: SandboxErrorClass | null;
  readonly errorMessage: string | null;
  readonly outcome: SandboxOutcome;
  /** Present only on a clean finish. Every failing path has the accumulator instead. */
  readonly result: SandboxResult | null;
}

/** A container that ran and was not killed for it. */
const DONE = { errorClass: null, errorMessage: null, outcome: "done" } as const;

/** A stop command. Not a thing that went wrong with a container. */
const INTERRUPTED = {
  errorClass: null,
  errorMessage: null,
  outcome: "interrupted",
} as const;

/** The kernel's verdict, whether the implementation raised it or returned it. */
const OOM_KILLED = {
  errorClass: "OomKilled",
  errorMessage:
    "the kernel killed the container for exceeding its memory limit",
  outcome: "oom_killed",
} as const;

/**
 * Reads the ending off the exit and the accumulator together, because neither
 * knows it alone.
 *
 * A success carries the whole result, and the only thing that can still make it
 * degraded is the kernel: an implementation that reports an OOM kill as data
 * rather than as a failure still produced an `oom_killed` container, and reading
 * it as `done` is how a host that is too small stops being visible. Everything
 * else about a success is `done` — a non-zero exit code included, and a failed
 * teardown too, which the run it followed should not be relabelled by.
 *
 * An interrupt gets no error class: this package's classes are all things that
 * went wrong with a container, and a stop command is not one of them.
 */
const endingOf = (
  exit: Exit.Exit<SandboxResult, unknown>,
  progress: SandboxProgress
): SandboxEnding => {
  if (exit._tag === "Success") {
    const ending = exit.value.oomKilled ? OOM_KILLED : DONE;
    return { ...ending, result: exit.value };
  }
  // Only a cause that is nothing but interrupts is a stop: work that failed and
  // was then torn down really failed, and calling it `interrupted` hides it.
  if (Cause.hasInterruptsOnly(exit.cause)) {
    return { ...INTERRUPTED, result: null };
  }
  const failure = Cause.findErrorOption(exit.cause);
  if (Option.isSome(failure) && isSandboxError(failure.value)) {
    return { ...describeError(failure.value), result: null };
  }
  // Anything else — a consumer's own error, or a raw third-party throw — is
  // named by the classifier from what the container left behind, and its text
  // goes through the sanitizer rather than onto the row unread.
  const thrown = Option.isSome(failure)
    ? failure.value
    : Cause.squash(exit.cause);
  const errorClass = classifySandboxFailure({
    exitCode: progress.exitCode,
    oomKilled: progress.oomKilled,
    stderr: progress.stderrTail,
    thrown,
  });
  return {
    errorClass,
    errorMessage: clipError(defectMessage(thrown)),
    outcome: outcomeOfClass(errorClass),
    result: null,
  };
};

/**
 * What the container actually did. A run that produced a result is described by
 * it, falling back to the accumulator only on the fields the result leaves null;
 * a run that produced none has the accumulator and nothing else, which is why it
 * exists at all.
 *
 * `containerMs` is null without a result rather than 0: a container that never
 * reported its own wall clock did not run for no time.
 */
const observedOf = (result: SandboxResult | null, progress: SandboxProgress) =>
  result === null
    ? {
        containerId: progress.containerId,
        containerMs: null,
        exitCode: progress.exitCode,
        imagePulled: progress.imagePulled,
        oomKilled: progress.oomKilled,
        peakMemoryBytes: progress.peakMemoryBytes,
        teardown: progress.teardown,
      }
    : {
        containerId: result.containerId ?? progress.containerId,
        containerMs: result.wallClockMs,
        exitCode: result.exitCode ?? progress.exitCode,
        imagePulled: result.imagePulled,
        oomKilled: result.oomKilled,
        peakMemoryBytes: result.peakMemoryBytes ?? progress.peakMemoryBytes,
        teardown: result.teardown,
      };

/**
 * Builds the row from the three things that know about the container: what was
 * asked for, what was observed, and how it ended.
 *
 * The economics are null throughout and that is not an omission. Cost, tokens
 * and turns belong to the agent turn inside the container, which writes its own
 * `atm.turn` row onto the event mount; carrying them here too would count every
 * run's spend twice. `queueWaitMs` is the loop's, measured before this container
 * existed. `durationMs` is the exception because it is measured across every
 * exit path by the combinator, so it is real even where nothing else is: a
 * container killed at 40 seconds genuinely ran for 40 seconds.
 */
const sandboxRow = (
  context: SandboxContext,
  progress: SandboxProgress,
  wide: WideEventContext<SandboxResult, unknown>
): SandboxEventInput => {
  const { spec } = context;
  const { hardening, identity } = spec;
  const ending = endingOf(wide.exit, progress);
  const observed = observedOf(ending.result, progress);
  return {
    containerId: observed.containerId,
    containerMs: observed.containerMs,
    costUsd: null,
    cpuLimit: hardening.cpus,
    durationMs: wide.durationMs,
    errorClass: ending.errorClass,
    errorMessage: ending.errorMessage,
    exitCode: observed.exitCode,
    hardeningProfile: hardeningProfileOf(hardening),
    image: spec.image,
    imagePulled: observed.imagePulled,
    kind: context.kind,
    memoryLimitMb: hardening.memoryMb,
    mountCount: spec.mounts.length,
    networkMode: hardening.network,
    oomKilled: observed.oomKilled,
    outcome: ending.outcome,
    peakMemoryBytes: observed.peakMemoryBytes,
    // A container is one row: the run's start row is the loop's to write, and
    // it is the one that makes an in-flight run queryable.
    phase: "end",
    pidsLimit: hardening.pidsLimit,
    queueWaitMs: null,
    readOnlyRootfs: hardening.readOnlyRootfs,
    runAsRoot: runsAsRoot(hardening.user),
    runId: identity.runId,
    sessionId: identity.sessionId,
    spanId: wide.spanId,
    taskId: identity.taskId,
    teardown: observed.teardown,
    timeoutMs: spec.timeoutMs,
    totalTokens: null,
    traceId: wide.traceId,
    turns: null,
    workspaceId: identity.workspaceId,
  };
};

/** The outcome union as a tuple, for the metric's tag vocabulary. */
export const SANDBOX_OUTCOMES = [
  ...BASE_OUTCOMES,
  ...SANDBOX_EXTRA_OUTCOMES,
] as const;

/**
 * The bounded projection of the same event: containers run, split three ways.
 * Every tag is drawn from a `const` tuple, so an unlisted value is a compile
 * error rather than a new time series, and the ids that make the event worth
 * querying — run, task, workspace, container — stay off it. The ceiling is
 * 2 × 6 × 4 series, and it cannot grow without this file changing.
 */
const sandboxRuns = boundedCounter("atm_sandbox_runs_total", {
  description: "Containers run, by implementation, ending and teardown",
  tags: {
    kind: SANDBOX_KINDS,
    outcome: SANDBOX_OUTCOMES,
    teardown: TEARDOWN_OUTCOMES,
  },
});

/**
 * Counts the container from the same ending the row reports, so the counter and
 * the ledger cannot disagree. Swallows its own failures — including a throw
 * while deriving the tags — because a metric may never mask the work it
 * describes.
 */
const recordSandboxMetric = (
  context: SandboxContext,
  exit: Exit.Exit<SandboxResult, unknown>
) =>
  Effect.gen(function* () {
    const progress = yield* Ref.get(context.progress);
    const ending = endingOf(exit, progress);
    yield* sandboxRuns.increment({
      kind: context.kind,
      outcome: ending.outcome,
      teardown: observedOf(ending.result, progress).teardown,
    });
  }).pipe(Effect.ignoreCause);

/**
 * Wraps one container run so it leaves exactly one `atm.sandbox` row and one
 * `sandbox.run` span, on every exit path — a clean finish, a typed failure, a
 * defect out of the daemon client, and the interrupt a stop command produces.
 *
 * The span is outermost deliberately. The wide event annotates the current span
 * as it emits, and the emit runs inside the wrapped effect's exit handler, so
 * the row's fields land on `sandbox.run` rather than on whatever the caller's
 * span happened to be — and the trace ids on the row are that span's.
 *
 * The accumulator is read synchronously as the run exits, from the cell the
 * implementation folded its facts into. That read is safe precisely there: the
 * fiber that wrote the cell has finished by the time the exit handler runs.
 *
 * @example
 * ```ts
 * const run = <E, R>(input: SandboxRunInput<E, R>) =>
 *   Effect.gen(function* () {
 *     const progress = yield* makeSandboxProgress;
 *     const work = Effect.gen(function* () {
 *       const started = yield* create(input.spec);
 *       yield* observeSandboxProgress(progress, started.facts);
 *       const waited = yield* streamAndWait(started, input.onOutput);
 *       yield* observeSandboxProgress(progress, waited.facts);
 *       const teardown = yield* remove(started);
 *       yield* observeSandboxProgress(progress, { teardown });
 *       return resultOf(input.spec, waited, teardown);
 *     });
 *     return yield* work.pipe(
 *       withSandboxEvent({ kind: "docker", progress, spec: input.spec })
 *     );
 *   });
 * ```
 */
export const withSandboxEvent =
  (context: SandboxContext) =>
  <E, R>(effect: Effect.Effect<SandboxResult, E, R>) =>
    effect.pipe(
      withWideEvent(SandboxEvent, (wide: WideEventContext<SandboxResult, E>) =>
        sandboxRow(context, Ref.getUnsafe(context.progress), wide)
      ),
      Effect.onExit((exit) => recordSandboxMetric(context, exit)),
      Effect.withSpan(SANDBOX_RUN_SPAN, {
        attributes: {
          hardeningProfile: hardeningProfileOf(context.spec.hardening),
          image: context.spec.image,
          kind: context.kind,
          mountCount: context.spec.mounts.length,
        },
      })
    );
