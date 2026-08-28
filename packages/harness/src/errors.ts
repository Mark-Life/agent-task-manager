/**
 * How a turn can fail, and how an unrecognized failure is given a name.
 *
 * Two vocabularies live here and they are deliberately different sizes. The
 * error classes are what a failure *is* — ten of them, because "the provider
 * refused us for quota" and "the socket died" want different reactions from the
 * orchestrator. The turn outcomes are how a turn *ended* — five, because that is
 * what a `GROUP BY` over the ledger should have to read.
 *
 * Both are closed unions, so every branch that produces a non-success has
 * exactly one value to set and a count over either is exhaustive by
 * construction. `no_terminal_event` is an outcome of its own for the same
 * reason: a provider that streamed a few events and then went quiet is a real
 * and recurring failure mode, and folding it into `errored` is how it stops
 * being countable.
 *
 * {@link classify} exists because most of what a provider throws is not one of
 * our errors at all — it is an SDK exception, a non-zero exit with stderr, or a
 * string. It is pure over that shape so the classification can be tested
 * without a provider, and it is the only place a raw message is read for
 * meaning.
 */

import { clipError } from "@workspace/telemetry";
import { Schema } from "effect";

/**
 * Why a turn was stopped from outside. `stopped` is a run command, `superseded`
 * is a newer prompt taking the session over, `shutdown` is the host going down —
 * kept apart because only the last one is the operator's own doing.
 */
export const INTERRUPT_REASONS = ["shutdown", "stopped", "superseded"] as const;

/** What ended a turn from outside it. */
export const InterruptReason = Schema.Literals(INTERRUPT_REASONS);
export type InterruptReason = typeof InterruptReason.Type;

/**
 * The names a failure can carry onto an event. They are the class names of the
 * errors below plus `Unknown`, which is what {@link classify} answers when it
 * genuinely cannot tell — a wrong guess would be worse than an admission.
 */
export const HARNESS_ERROR_CLASSES = [
  "Interrupted",
  "NetworkFailed",
  "NoTerminalEvent",
  "ProcessFailed",
  "ProviderCrashed",
  "QuotaExhausted",
  "RateLimited",
  "TimedOut",
  "Unauthenticated",
  "Unknown",
] as const;

/** The classification of a failure, as it lands on an event. */
export const HarnessErrorClass = Schema.Literals(HARNESS_ERROR_CLASSES);
export type HarnessErrorClass = typeof HarnessErrorClass.Type;

/**
 * How a turn ended. Wider than the base telemetry outcomes by exactly one
 * literal: a turn that produced no terminus is neither a success nor an error
 * anyone can act on, and it is the one failure a silent provider produces.
 */
export const TURN_OUTCOMES = [
  "done",
  "errored",
  "interrupted",
  "timeout",
  "no_terminal_event",
] as const;

/** The terminus of one provider invocation. */
export const TurnOutcome = Schema.Literals(TURN_OUTCOMES);
export type TurnOutcome = typeof TurnOutcome.Type;

/** The turn was stopped from outside: a command, a newer prompt, a shutdown. */
export class Interrupted extends Schema.TaggedErrorClass<Interrupted>()(
  "Harness.Interrupted",
  { reason: InterruptReason }
) {}

/** The turn outlived its cap. The cap is named so the ledger says which one. */
export class TimedOut extends Schema.TaggedErrorClass<TimedOut>()(
  "Harness.TimedOut",
  { timeoutMs: Schema.Number }
) {}

/**
 * The provider's process exited non-zero. `stderr` is raw third-party text and
 * is sanitized where it reaches an event, never here.
 */
export class ProcessFailed extends Schema.TaggedErrorClass<ProcessFailed>()(
  "Harness.ProcessFailed",
  { exitCode: Schema.Int, stderr: Schema.String }
) {}

/**
 * The provider could not be run or died mid-stream: a missing binary, a stream
 * that threw, an SDK defect. Distinct from {@link ProcessFailed}, which at
 * least got as far as an exit code.
 */
export class ProviderCrashed extends Schema.TaggedErrorClass<ProviderCrashed>()(
  "Harness.ProviderCrashed",
  { cause: Schema.Unknown, message: Schema.String }
) {}

/**
 * The stream ended without a terminus. Its own error because the alternative is
 * a run that looks fine and produced nothing: `eventsSeen` is what distinguishes
 * a provider that never started from one that stopped halfway.
 */
export class NoTerminalEvent extends Schema.TaggedErrorClass<NoTerminalEvent>()(
  "Harness.NoTerminalEvent",
  { eventsSeen: Schema.Natural }
) {}

/**
 * The provider refused on rate or subscription limits. `retryAfterMs` is null
 * where the provider does not say, which is most of the time — a fabricated
 * backoff is worse than no backoff, because the caller will trust it.
 */
export class RateLimited extends Schema.TaggedErrorClass<RateLimited>()(
  "Harness.RateLimited",
  { retryAfterMs: Schema.NullOr(Schema.Number) }
) {}

/**
 * The account is out of credit or past its plan allowance. Separate from
 * {@link RateLimited} because waiting fixes one and not the other.
 */
export class QuotaExhausted extends Schema.TaggedErrorClass<QuotaExhausted>()(
  "Harness.QuotaExhausted",
  { detail: Schema.String }
) {}

/**
 * The provider has no usable credentials: no login, an expired token, a
 * credentials file that never reached the sandbox. Never retried — the run is
 * over until a human logs in again.
 */
export class Unauthenticated extends Schema.TaggedErrorClass<Unauthenticated>()(
  "Harness.Unauthenticated",
  { detail: Schema.String }
) {}

/** The network failed under the provider: DNS, TLS, a reset socket. */
export class NetworkFailed extends Schema.TaggedErrorClass<NetworkFailed>()(
  "Harness.NetworkFailed",
  { detail: Schema.String }
) {}

/** Everything a turn can fail with. The failure channel of a provider run. */
export type HarnessError =
  | Interrupted
  | NetworkFailed
  | NoTerminalEvent
  | ProcessFailed
  | ProviderCrashed
  | QuotaExhausted
  | RateLimited
  | TimedOut
  | Unauthenticated;

/**
 * Tag to class name. Written out rather than derived by stripping the prefix,
 * so a renamed tag is a compile error here instead of a silently new value in
 * the ledger.
 */
const CLASS_OF_TAG = {
  "Harness.Interrupted": "Interrupted",
  "Harness.NetworkFailed": "NetworkFailed",
  "Harness.NoTerminalEvent": "NoTerminalEvent",
  "Harness.ProcessFailed": "ProcessFailed",
  "Harness.ProviderCrashed": "ProviderCrashed",
  "Harness.QuotaExhausted": "QuotaExhausted",
  "Harness.RateLimited": "RateLimited",
  "Harness.TimedOut": "TimedOut",
  "Harness.Unauthenticated": "Unauthenticated",
} as const satisfies Record<HarnessError["_tag"], HarnessErrorClass>;

/** The classification of a typed harness failure. */
export const errorClassOf = (error: HarnessError) => CLASS_OF_TAG[error._tag];

/**
 * Classification to outcome. Only three classes are anything other than an
 * error: a stop is not a failure, a cap being hit is its own thing, and silence
 * is the one that would otherwise disappear.
 */
const OUTCOME_OF_CLASS = {
  Interrupted: "interrupted",
  NetworkFailed: "errored",
  NoTerminalEvent: "no_terminal_event",
  ProcessFailed: "errored",
  ProviderCrashed: "errored",
  QuotaExhausted: "errored",
  RateLimited: "errored",
  TimedOut: "timeout",
  Unauthenticated: "errored",
  Unknown: "errored",
} as const satisfies Record<HarnessErrorClass, TurnOutcome>;

/** How a turn ends given what went wrong. Total over the classification union. */
export const outcomeOfClass = (errorClass: HarnessErrorClass) =>
  OUTCOME_OF_CLASS[errorClass];

/** The human-readable half of a typed failure, before sanitizing. */
const messageOf = (error: HarnessError): string => {
  switch (error._tag) {
    case "Harness.Interrupted":
      return `interrupted: ${error.reason}`;
    case "Harness.NetworkFailed":
      return error.detail;
    case "Harness.NoTerminalEvent":
      return `the provider stream ended after ${error.eventsSeen} events without a terminus`;
    case "Harness.ProcessFailed":
      return error.stderr.trim() || `exited with code ${error.exitCode}`;
    case "Harness.ProviderCrashed":
      return error.message;
    case "Harness.QuotaExhausted":
      return error.detail;
    case "Harness.RateLimited":
      return error.retryAfterMs === null
        ? "rate limited"
        : `rate limited, retry after ${error.retryAfterMs}ms`;
    case "Harness.TimedOut":
      return `exceeded the ${error.timeoutMs}ms cap`;
    default:
      return error.detail;
  }
};

/**
 * The three fields a failure puts on an event, from the one place that holds
 * the tag. The message goes through the shared sanitizer here rather than at the
 * emit site, because the text is a provider's and a provider's text is where a
 * token turns up.
 */
export const describeError = (error: HarnessError) => {
  const errorClass = errorClassOf(error);
  return {
    errorClass,
    errorMessage: clipError(messageOf(error)),
    outcome: outcomeOfClass(errorClass),
  } as const;
};

/**
 * Phrases that contain a limit-ish word but name a different failure. Matching
 * one vetoes a rate or quota classification: a prompt that overflowed the
 * context window is not a drained subscription, and pausing a healthy provider
 * over it idles the whole pool.
 */
const FALSE_LIMIT_GUARDS: readonly string[] = [
  "character limit",
  "content limit",
  "context length",
  "context window",
  "maximum context",
  "policy",
  "size limit",
  "token limit",
  "tool call limit",
];

/**
 * Anchors per class, in the order they are tried. Order is the whole design:
 * a timeout enforced with an `AbortController` says both "timed out" and
 * "aborted", and reading it as a stop would hide a cap that needs raising.
 * Auth is tried before quota because an expired login and an empty balance both
 * come back as a billing-flavoured 4xx.
 */
const ANCHORS: readonly (readonly [HarnessErrorClass, readonly string[]])[] = [
  ["TimedOut", ["deadline exceeded", "etimedout", "timed out", "timeout"]],
  [
    "Interrupted",
    [
      "abort_err",
      "aborted",
      "abortsignal",
      "canceled",
      "cancelled",
      "sigint",
      "sigterm",
    ],
  ],
  [
    "Unauthenticated",
    [
      "401",
      "authentication_error",
      "expired token",
      "invalid api key",
      "invalid_api_key",
      "login required",
      "not logged in",
      "unauthorized",
    ],
  ],
  [
    "QuotaExhausted",
    [
      "billing",
      "credit balance",
      "insufficient_quota",
      "out of credits",
      "quota",
      "usage limit",
    ],
  ],
  [
    "RateLimited",
    ["429", "overloaded", "rate limit", "rate_limit", "too many requests"],
  ],
  [
    "NetworkFailed",
    [
      // Pi's own wording for a socket that never opened, which is what it says
      // on every attempt of a retried request to an unreachable endpoint.
      "connection error",
      "eai_again",
      "econnrefused",
      "econnreset",
      "ehostunreach",
      "epipe",
      "fetch failed",
      "network error",
      "socket hang up",
      "tls handshake",
    ],
  ],
  [
    "ProviderCrashed",
    ["command not found", "eacces", "enoent", "exec format error", "spawn"],
  ],
];

/** The classes a false-limit guard can veto. */
const GUARDED_CLASSES: readonly HarnessErrorClass[] = [
  "QuotaExhausted",
  "RateLimited",
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

/** The tag of a thrown value, when it is one of ours. */
const classOfThrown = (thrown: unknown) => {
  const tag = (thrown as { readonly _tag?: unknown } | null)?._tag;
  return typeof tag === "string" && tag in CLASS_OF_TAG
    ? CLASS_OF_TAG[tag as HarnessError["_tag"]]
    : null;
};

/**
 * How much of a provider's stderr is kept for {@link classify}. The tail rather
 * than the head: a CLI prints its progress first and its reason last, so a
 * bounded buffer that keeps the beginning classifies every failure as `Unknown`.
 * Four kilobytes covers a stack trace and refuses to hold a leaked file.
 */
export const STDERR_TAIL_CHARS = 4096;

/** The last {@link STDERR_TAIL_CHARS} characters of whatever has been read so far. */
export const keepStderrTail = (text: string) =>
  text.length > STDERR_TAIL_CHARS ? text.slice(-STDERR_TAIL_CHARS) : text;

/** What a failed turn hands the classifier: any or all of it may be absent. */
export interface FailureShape {
  /** Non-zero means the provider process ran and refused; null means it never got that far. */
  readonly exitCode?: number | null;
  /** Whatever the provider wrote to stderr, raw. */
  readonly stderr?: string | null;
  /** Whatever was thrown or failed with — one of ours, an `Error`, or anything. */
  readonly thrown?: unknown;
}

/**
 * Names a failure, from a typed error, a message, a stderr, an exit code, or
 * any mixture. Pure and case-insensitive.
 *
 * The order of the checks is the classification: a typed error already knows
 * what it is, then the anchors are tried in the order declared above, then a
 * non-zero exit is a process failure, and only text that matched nothing at all
 * comes back `Unknown`. Conservative on purpose — a miss costs a vaguer ledger
 * row, a wrong match costs a paused provider or a retry that will never work.
 */
export const classify = ({
  exitCode,
  stderr,
  thrown,
}: FailureShape): HarnessErrorClass => {
  const typed = classOfThrown(thrown);
  if (typed !== null) {
    return typed;
  }
  const text = `${textOfThrown(thrown)} ${stderr ?? ""}`.toLowerCase().trim();
  const guarded = FALSE_LIMIT_GUARDS.some((guard) => text.includes(guard));
  for (const [errorClass, anchors] of ANCHORS) {
    if (guarded && GUARDED_CLASSES.includes(errorClass)) {
      continue;
    }
    if (anchors.some((anchor) => text.includes(anchor))) {
      return errorClass;
    }
  }
  return typeof exitCode === "number" && exitCode !== 0
    ? "ProcessFailed"
    : "Unknown";
};
