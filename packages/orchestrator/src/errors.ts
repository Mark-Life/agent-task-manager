/**
 * How dispatch can fail, and how any failure at all is given the one name that
 * lands on the run row and on the `atm.run` event.
 *
 * The taxonomy mirrors `@workspace/harness` and `@workspace/sandbox` in shape —
 * typed errors for what the loop itself can do wrong, a closed union of class
 * names for the ledger — and it exists at a third layer for a reason: a run can
 * die inside the model, inside the container, or inside the loop that arranged
 * both, and a `GROUP BY errorClass` that cannot tell those apart is the query
 * an operator actually needs.
 *
 * {@link classifyFailure} is the only classifier the run lifecycle calls. It is
 * total over anything at all, and it delegates rather than re-deciding: a
 * harness tag keeps the harness's name, a sandbox tag keeps the sandbox's, a
 * repository failure becomes one persistence name, and text that matches
 * nothing goes through the harness's own anchor matching — which is already the
 * one place in this system where a raw message is read for meaning.
 *
 * Two names deliberately differ from a neighbour's. Ours is {@link AlreadyLive}
 * and not `RunAlreadyLive`, because `@workspace/db` exports that name for the
 * repository's refusal to insert a second live run; this one is the
 * dispatcher's own skip signal, and sharing a symbol would make every importer
 * of both packages alias one. `PersistenceFailed` is a class with no error of
 * ours behind it, exactly as the harness's `Unknown` is: it is what a database
 * failure is called on a row, not something the loop raises.
 */

import {
  RunId,
  type RunOutcome,
  RunSubject,
  SessionProvider,
} from "@workspace/domain";
import {
  classify,
  HARNESS_ERROR_CLASSES,
  type HarnessErrorClass,
} from "@workspace/harness";
import {
  redactRemote,
  SANDBOX_ERROR_CLASSES,
  type SandboxError,
  type SandboxErrorClass,
} from "@workspace/sandbox";
import { clipError } from "@workspace/telemetry";
import { Schema } from "effect";

/**
 * Which read an ingest was doing when it failed. Its own field rather than
 * three error classes, because the recovery is identical — the run is over
 * either way — and the question worth asking later is which of the three reads
 * is the flaky one.
 */
export const INGEST_SOURCES = ["artifacts", "events", "transcript"] as const;

/** What an ingest was reading back off the run directory. */
export const IngestSource = Schema.Literals(INGEST_SOURCES);
export type IngestSource = typeof IngestSource.Type;

/**
 * A claimed task could not be turned into a running container: the session row,
 * the run row, the workspace, or the container itself. `cause` is whatever
 * actually went wrong, kept whole for the log and never for a row.
 */
export class DispatchFailed extends Schema.TaggedErrorClass<DispatchFailed>()(
  "Orchestrator.DispatchFailed",
  { cause: Schema.Unknown, detail: Schema.String, subject: RunSubject }
) {}

/**
 * The lease this loop held is no longer ours — expired under a slow heartbeat,
 * or reclaimed by a loop that thought we had crashed. The run is abandoned
 * rather than raced: two containers on one subject means two writers on one
 * artifacts directory or two answers in one conversation, which is the failure
 * the lease exists to prevent.
 */
export class LeaseLost extends Schema.TaggedErrorClass<LeaseLost>()(
  "Orchestrator.LeaseLost",
  { detail: Schema.String, runId: RunId, subject: RunSubject }
) {}

/**
 * Startup could not read or clear the leases a previous process left behind.
 * Fatal at boot on purpose: a loop that cannot see the old leases cannot tell a
 * crashed run from a live one, and dispatching under that uncertainty is how a
 * second container joins a run that is still going.
 */
export class LeaseReclaimFailed extends Schema.TaggedErrorClass<LeaseReclaimFailed>()(
  "Orchestrator.LeaseReclaimFailed",
  { cause: Schema.Unknown, detail: Schema.String }
) {}

/**
 * The subject already has a container working on it. A signal, not a fault —
 * the dispatcher skips and moves on, which is what makes "one run per task and
 * one turn per thread" hold when a notify and a poll arrive at once.
 */
export class AlreadyLive extends Schema.TaggedErrorClass<AlreadyLive>()(
  "Orchestrator.AlreadyLive",
  { runId: Schema.NullOr(RunId), subject: RunSubject }
) {}

/**
 * The prompt could not be assembled: the task, its messages since the session's
 * watermark, its acceptance criteria and its artifacts. Its own class because
 * it happens before a container exists, so the run cost nothing and the fix is
 * always data rather than capacity.
 */
export class PromptBuildFailed extends Schema.TaggedErrorClass<PromptBuildFailed>()(
  "Orchestrator.PromptBuildFailed",
  { cause: Schema.Unknown, subject: RunSubject }
) {}

/**
 * Reading back what the run left on disk failed. The container is already gone
 * by then, so this never costs the work — it costs the record of it, which is
 * why the source is on the error and the run still closes out.
 */
export class IngestFailed extends Schema.TaggedErrorClass<IngestFailed>()(
  "Orchestrator.IngestFailed",
  { cause: Schema.Unknown, runId: RunId, source: IngestSource }
) {}

/**
 * A provider is out of subscription allowance, so dispatch on it is paused
 * rather than spent. `resumesAtMs` is null where the provider did not say when
 * the window rolls over — a fabricated wait is worse than none, because the
 * gate would trust it and hold the pool closed past the reset.
 */
export class QuotaPaused extends Schema.TaggedErrorClass<QuotaPaused>()(
  "Orchestrator.QuotaPaused",
  {
    detail: Schema.String,
    provider: SessionProvider,
    resumesAtMs: Schema.NullOr(Schema.Number),
  }
) {}

/** Everything the loop itself can fail with. */
export type OrchestratorError =
  | AlreadyLive
  | DispatchFailed
  | IngestFailed
  | LeaseLost
  | LeaseReclaimFailed
  | PromptBuildFailed
  | QuotaPaused;

/**
 * The names the loop's own failures carry onto a row.
 *
 * Two of them have no error of ours behind them, which is deliberate rather
 * than an omission. `PersistenceFailed` is what a database failure is called on
 * a row. `BoardAccessLost` is read off the run's own event stream at the close
 * rather than raised — nothing fails when a worker loses the board, which is
 * precisely the problem it names; see `./board-access`.
 */
export const ORCHESTRATOR_ERROR_CLASSES = [
  "AlreadyLive",
  "BoardAccessLost",
  "DispatchFailed",
  "IngestFailed",
  "LeaseLost",
  "LeaseReclaimFailed",
  "PersistenceFailed",
  "PromptBuildFailed",
  "QuotaPaused",
] as const;

/** The classification of an orchestrator failure, as it lands on an event. */
export const OrchestratorErrorClass = Schema.Literals(
  ORCHESTRATOR_ERROR_CLASSES
);
export type OrchestratorErrorClass = typeof OrchestratorErrorClass.Type;

/**
 * Tag to class name. Written out rather than derived by stripping the prefix,
 * so a renamed tag is a compile error here instead of a silently new value in
 * the ledger.
 */
const CLASS_OF_TAG = {
  "Orchestrator.AlreadyLive": "AlreadyLive",
  "Orchestrator.DispatchFailed": "DispatchFailed",
  "Orchestrator.IngestFailed": "IngestFailed",
  "Orchestrator.LeaseLost": "LeaseLost",
  "Orchestrator.LeaseReclaimFailed": "LeaseReclaimFailed",
  "Orchestrator.PromptBuildFailed": "PromptBuildFailed",
  "Orchestrator.QuotaPaused": "QuotaPaused",
} as const satisfies Record<OrchestratorError["_tag"], OrchestratorErrorClass>;

/** The classification of a typed orchestrator failure. */
export const errorClassOf = (error: OrchestratorError) =>
  CLASS_OF_TAG[error._tag];

/**
 * Every name a run's `errorClass` can hold. Three vocabularies rather than one,
 * because each package owns the failures it can actually name, and a run passes
 * through all three.
 */
export type RunErrorClass =
  | HarnessErrorClass
  | OrchestratorErrorClass
  | SandboxErrorClass;

/**
 * The same set as a list, deduplicated: `TimedOut` and `Unknown` are named by
 * both the harness and the sandbox, and mean the same thing on a row either
 * way. For iteration and for the test that asserts the outcome map is total.
 */
export const RUN_ERROR_CLASSES: readonly RunErrorClass[] = [
  ...new Set<RunErrorClass>([
    ...ORCHESTRATOR_ERROR_CLASSES,
    ...HARNESS_ERROR_CLASSES,
    ...SANDBOX_ERROR_CLASSES,
  ]),
];

/**
 * How each classification ends a run. Total over the union, so a new class is a
 * compile error here rather than a run that quietly counts as `errored`.
 *
 * Only three classes are anything other than an error. A stop is not a failure,
 * a cap being hit is its own fact and wants a bigger cap rather than a retry,
 * and a provider that went quiet is the `lost` the reconcile was built for —
 * folding any of them into `errored` is how each stops being countable.
 */
const OUTCOME_OF_CLASS = {
  AlreadyLive: "errored",
  BoardAccessLost: "errored",
  CloneFailed: "errored",
  ContainerStartFailed: "errored",
  DaemonUnreachable: "errored",
  DispatchFailed: "errored",
  EnvFileWriteFailed: "errored",
  ImageMissing: "errored",
  IngestFailed: "errored",
  Interrupted: "interrupted",
  LeaseLost: "errored",
  LeaseReclaimFailed: "errored",
  MountSourceMissing: "errored",
  NetworkFailed: "errored",
  NoTerminalEvent: "lost",
  OomKilled: "errored",
  PersistenceFailed: "errored",
  ProcessFailed: "errored",
  PromptBuildFailed: "errored",
  ProviderCrashed: "errored",
  QuotaExhausted: "errored",
  QuotaPaused: "errored",
  RateLimited: "errored",
  TeardownFailed: "errored",
  TimedOut: "timeout",
  Unauthenticated: "errored",
  Unknown: "errored",
} as const satisfies Record<RunErrorClass, RunOutcome>;

/** How a run ends given what went wrong. Total over the classification union. */
export const runOutcomeOfClass = (errorClass: RunErrorClass) =>
  OUTCOME_OF_CLASS[errorClass];

/** The `_tag` of a value, when it has a string one. */
const tagOf = (failure: unknown) => {
  const tag = (failure as { readonly _tag?: unknown } | null)?._tag;
  return typeof tag === "string" ? tag : null;
};

/** How `@workspace/sandbox` prefixes its tags. */
const SANDBOX_TAG_PREFIX = "Sandbox.";

/** The sandbox class a sandbox tag names, or null when it is not one. */
const sandboxClassOf = (tag: string) => {
  if (!tag.startsWith(SANDBOX_TAG_PREFIX)) {
    return null;
  }
  const name = tag.slice(SANDBOX_TAG_PREFIX.length);
  return (SANDBOX_ERROR_CLASSES as readonly string[]).includes(name)
    ? (name as SandboxErrorClass)
    : null;
};

/**
 * Repository tags this loop recognizes individually. `RunRepo.AlreadyLive` is
 * the same fact as our own skip signal — the partial unique index refusing a
 * second live run — and a row that called it a persistence failure would put a
 * successful concurrency guard in the error budget.
 */
const CLASS_OF_STORE_TAG: Readonly<Record<string, RunErrorClass>> = {
  "RunRepo.AlreadyLive": "AlreadyLive",
};

/**
 * Whether a tag came from `@workspace/db`. Its errors are tagged either under
 * `Db.` or under the repository that raised them, and both spellings are the
 * database being the thing that failed.
 */
const isStoreTag = (tag: string) =>
  tag.startsWith("Db.") || tag.includes("Repo.");

/**
 * Names any failure at all. Pure, total, and the only classifier the run
 * lifecycle calls.
 *
 * The order is the classification: our own tag, then a sandbox tag, then a
 * repository tag, and only then the harness's text matching — which already
 * handles its own typed errors, an SDK exception, a stderr blob and a bare
 * string, and answers `Unknown` rather than guessing. Conservative on purpose:
 * a miss costs a vaguer row, a wrong match costs a paused provider or a retry
 * that was never going to work.
 */
export const classifyFailure = (failure: unknown): RunErrorClass => {
  const tag = tagOf(failure);
  if (tag !== null) {
    if (tag in CLASS_OF_TAG) {
      return CLASS_OF_TAG[tag as OrchestratorError["_tag"]];
    }
    const sandbox = sandboxClassOf(tag);
    if (sandbox !== null) {
      return sandbox;
    }
    const store = CLASS_OF_STORE_TAG[tag];
    if (store !== undefined) {
      return store;
    }
    if (isStoreTag(tag)) {
      return "PersistenceFailed";
    }
  }
  return classify({ thrown: failure });
};

/** The human-readable half of one of our failures, before sanitizing. */
const messageOf = (error: OrchestratorError): string => {
  switch (error._tag) {
    case "Orchestrator.AlreadyLive":
      return "a run is already live on this subject";
    case "Orchestrator.DispatchFailed":
      return error.detail;
    case "Orchestrator.IngestFailed":
      return `reading the run's ${error.source} back failed`;
    case "Orchestrator.LeaseLost":
      return error.detail;
    case "Orchestrator.LeaseReclaimFailed":
      return error.detail;
    case "Orchestrator.PromptBuildFailed":
      return "the prompt could not be assembled";
    default:
      return error.detail;
  }
};

/** A process's exit code, when it had one, as a clause to append. */
const exitClause = (exitCode: number | null) =>
  exitCode === null ? "" : ` (exit ${exitCode})`;

/** A tool's own output, when it produced any, as a clause to append. */
const outputClause = (stderr: string) => {
  const text = stderr.trim();
  return text.length === 0 ? "" : `: ${text}`;
};

/**
 * What a container or a checkout failed at, in a sentence.
 *
 * Every one of these errors already carries the fields that answer "why" — the
 * repository and git's own stderr, the image, the path a mount pointed at, the
 * limit the kernel enforced. None of it used to reach anybody: sandbox tags are
 * not in {@link CLASS_OF_TAG}, so a failure fell through to
 * {@link textOfUnknown}, which reads `message` off an `Error` that never had
 * one — and every sandbox failure arrived on the run row, the crash message and
 * the wide event as a bare tag and a colon. `Sandbox.CloneFailed:` cannot be
 * told from a network outage, a missing branch, or a private repository with no
 * credential, which are three different things to go and do.
 *
 * Exhaustive over the union rather than defaulted, so a new sandbox error is a
 * compile error here instead of another bare tag.
 */
const sandboxMessageOf = (error: SandboxError): string => {
  switch (error._tag) {
    case "Sandbox.CloneFailed":
      return `cloning ${error.repo} failed${exitClause(error.exitCode)}${outputClause(error.stderr)}`;
    case "Sandbox.ContainerStartFailed":
      return `the container never started from ${error.image}${exitClause(error.exitCode)}${outputClause(error.stderr)}`;
    case "Sandbox.DaemonUnreachable":
      return `the docker daemon could not be reached: ${error.detail}`;
    case "Sandbox.EnvFileWriteFailed":
      return `the project env file ${error.path} could not be written into the checkout`;
    case "Sandbox.ImageMissing":
      return `the image ${error.image} is not on this host and could not be pulled: ${error.detail}`;
    case "Sandbox.MountSourceMissing":
      return `the ${error.purpose} mount points at ${error.hostPath}, which does not exist`;
    case "Sandbox.OomKilled":
      return `the kernel killed the container for exceeding its ${error.limitMb}MB limit`;
    case "Sandbox.TimedOut":
      return `the container outlived its ${error.timeoutMs}ms cap`;
    default:
      return `the container could not be removed${outputClause(String(error.cause))}`;
  }
};

/** Whatever text a thrown value carries, in whichever shape it arrived. */
const textOfUnknown = (failure: unknown): string => {
  if (typeof failure === "string") {
    return failure;
  }
  if (failure instanceof Error) {
    return `${failure.name}: ${failure.message}`;
  }
  const message = (failure as { readonly message?: unknown } | null)?.message;
  return typeof message === "string" ? message : "";
};

/**
 * The failure's own words, from whichever of the three vocabularies it speaks:
 * one of ours, one of the sandbox's, or whatever a thrown value carried.
 */
const textOf = (input: {
  readonly failure: unknown;
  readonly ours: boolean;
  readonly sandbox: ReturnType<typeof sandboxClassOf>;
}): string => {
  if (input.ours) {
    return messageOf(input.failure as OrchestratorError);
  }
  if (input.sandbox === null) {
    return textOfUnknown(input.failure);
  }
  return sandboxMessageOf(input.failure as SandboxError);
};

/**
 * The three fields a failure puts on the run row, the crash message and the
 * wide event, from the one place that holds the tag.
 *
 * The message is sanitized here rather than at each emit site, because most of
 * what reaches this function is a provider's or a daemon's text, and that is
 * where a token turns up.
 */
export const describeFailure = (failure: unknown) => {
  const errorClass = classifyFailure(failure);
  const tag = tagOf(failure);
  const sandbox = tag === null ? null : sandboxClassOf(tag);
  const ours = tag !== null && tag in CLASS_OF_TAG;
  const text = textOf({ failure, ours, sandbox });
  return {
    errorClass,
    // Both sanitizers, because they cover different shapes: the shared one
    // knows bearer tokens and API keys, and a clone URL carries a credential in
    // a form — `https://user:pass@host` — that it does not.
    errorMessage: clipError(redactRemote(text.length > 0 ? text : errorClass)),
    outcome: runOutcomeOfClass(errorClass),
  } as const;
};
