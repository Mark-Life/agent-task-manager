/**
 * What a claimed piece of work is, and how it ended. Two immutable records and
 * the pure reads over them; nothing here resolves anything.
 *
 * {@link DispatchContext} is built once, at the moment a lease is claimed, and
 * then handed to every stage of the run unchanged: the prompt builder, the
 * workspace, the sandbox, the event ingest, the terminal handler, the wide
 * event. It is one record rather than six arguments because the alternative is
 * six stages each re-deriving the same answer — which repo a task with no
 * project actually clones, which session a `latest` selection resolved to, what
 * the run directory is called — and the second derivation is where they
 * disagree. Everything on it is already resolved: this file is the shape of the
 * answer, not the search for it.
 *
 * {@link RunTerminus} is the other half of the seam. Three things read how a
 * run ended and they have to agree exactly: what the close writes back to
 * whatever the run was attached to, the run row's outcome and economics, and
 * the `atm.run` event. A union with a case per ending is what makes "did this
 * count as a failure" one function rather than three `if`s that drift.
 *
 * The three endings are the ones the design names, and the third is the point.
 * A clean finish and a crash both arrive as a terminal event; a process that
 * simply goes quiet — an abort mid-stream, an OOM kill, a container removed
 * under the loop — emits nothing at all, and treating that as a failure in its
 * own right is what keeps it from looking like a run that is still going.
 */

import type {
  Actor,
  ActorKind,
  AgentSession,
  CostUsd,
  NextSession,
  Project,
  RunId,
  RunOutcome,
  RunTrigger,
  SessionProvider,
} from "@workspace/domain";
import type { InterruptReason, RunLayout } from "@workspace/harness";
import type { RunIdentity } from "@workspace/sandbox";
import { type RunErrorClass, runOutcomeOfClass } from "./errors";
import {
  type RunAttachment,
  subjectOfAttachment,
  taskIdOfAttachment,
  threadIdOfAttachment,
  workspaceIdOfAttachment,
} from "./subject";

/**
 * A run starting a conversation from nothing. The session row still exists and
 * is written before the run — a run always belongs to one — so this is about
 * what the provider is told, not about whether a row is there.
 */
export interface FreshSession {
  readonly mode: "fresh";
  /** Which selection on the task produced it, kept for the ledger. */
  readonly selected: NextSession["mode"];
  readonly session: AgentSession;
}

/**
 * A run continuing an earlier conversation. The provider's own session id is
 * required and non-null: a "resumed" session that has no id to resume is a
 * fresh one, and letting it be null here is how a review loop silently starts
 * over with no history.
 */
export interface ResumedSession {
  readonly mode: "resumed";
  /** The provider's id for the conversation, which is what a resume is. */
  readonly providerSessionId: string;
  readonly selected: NextSession["mode"];
  readonly session: AgentSession;
}

/**
 * Which conversation this run is. Resolved from the task's next-session
 * selection — see `nextSessionOf` in `@workspace/domain` — before the run row
 * exists, and the selection is cleared back to the default in the same write.
 */
export type ResolvedSession = FreshSession | ResumedSession;

/**
 * Everything one dispatch carries, from the claim to the last row it writes.
 *
 * Immutable by construction: a stage that learns something new produces a
 * value, it does not edit this. The one field that looks mutable is
 * {@link DispatchContext.attempt}, and it is a number decided at claim time —
 * the next attempt is a different context on a different run.
 */
export interface DispatchContext {
  /**
   * Who this run's writes are performed as. The loop's own writes are the
   * `orchestrator` actor carrying this run's id; the container writes as
   * `worker_run` through its own token, and that actor is not this one.
   */
  readonly actor: Actor;
  /**
   * What this run is working on, and therefore which role it is. Every reader
   * below flows from it, and the four things a role is allowed to change — the
   * prompt, the tool credential's binding, the image, and which table the
   * attachment points at — are the only places it is branched on.
   */
  readonly attached: RunAttachment;
  /** 1-based. The retry ladder and the park decision both count from here. */
  readonly attempt: number;
  /** The image that will actually run, already defaulted from the task's selection. */
  readonly image: string;
  /** Where this run's files live on the host. The container sees `containerRunLayout`. */
  readonly layout: RunLayout;
  /** Null for a task that belongs to no project — an ordinary case, not a missing one. */
  readonly project: Project | null;
  /** Which harness, already resolved from the session, the task and the default. */
  readonly provider: SessionProvider;
  /** How long the task waited between entering *in progress* and this claim. */
  readonly queueWaitMs: number;
  /**
   * The repo to clone, already resolved: the task's override, else the
   * project's, else null. Null is a scratch workspace, which is the whole of
   * the difference between a coding task and a personal one at this layer.
   */
  readonly repoUrl: string | null;
  readonly runId: RunId;
  readonly session: ResolvedSession;
  /** The claim span, captured at the top so an `onExit` emit still has it. */
  readonly spanId: string | null;
  readonly traceId: string | null;
  /** W3C `traceparent` for the container, so the turns inside it join this trace. */
  readonly traceparent: string | null;
  /** Why this run exists: a status change, a rerun, research, a manual start. */
  readonly trigger: RunTrigger;
}

/** Which role this run is, which is the same fact as what it is attached to. */
export const roleOf = (context: DispatchContext) => context.attached.role;

/** The id pair a repository is told to write on this run's rows. */
export const subjectOf = (context: DispatchContext) =>
  subjectOfAttachment(context.attached);

/** The task this run is for, or null on a manager run. */
export const taskIdOf = (context: DispatchContext) =>
  taskIdOfAttachment(context.attached);

/** The conversation this run is answering in, or null on a worker run. */
export const threadIdOf = (context: DispatchContext) =>
  threadIdOfAttachment(context.attached);

/** The session row this run belongs to. */
export const sessionIdOf = (context: DispatchContext) =>
  context.session.session.id;

/** The workspace every row this run writes is scoped to. */
export const workspaceIdOf = (context: DispatchContext) =>
  workspaceIdOfAttachment(context.attached);

/** The project, or null where the task belongs to none. */
export const projectIdOf = (context: DispatchContext) =>
  context.project?.id ?? null;

/**
 * The provider session id to continue, or null to start fresh. The one read the
 * harness's `RunOptions.resumeSessionId` takes, so the resume decision is made
 * once and never re-derived from a session row's nullable column.
 */
export const resumeSessionIdOf = (context: DispatchContext) =>
  context.session.mode === "resumed" ? context.session.providerSessionId : null;

/** Whether this run starts a conversation rather than continuing one. */
export const isFreshSession = (context: DispatchContext) =>
  context.session.mode === "fresh";

/** Whether this run clones something, as against getting an empty scratch dir. */
export const hasRepo = (context: DispatchContext) => context.repoUrl !== null;

/** The normalized event file the container appends to and the ingest reads back. */
export const eventLogPathOf = (context: DispatchContext) =>
  context.layout.eventLogPath;

/**
 * The ids a container is started with. The sandbox merges these into the run's
 * environment and they win over anything the caller sets, which is what makes
 * an `atm.turn` row written inside the container joinable to the `atm.run` row
 * written outside it.
 */
export const runIdentityOf = (context: DispatchContext): RunIdentity => ({
  runId: context.runId,
  sessionId: sessionIdOf(context),
  taskId: taskIdOf(context),
  traceparent: context.traceparent,
  workspaceId: workspaceIdOf(context),
});

/**
 * The identity fields of the wide event, in the shape `@workspace/telemetry`
 * declares them: strings or null, never a placeholder. One reader, so the loop
 * and any later emitter cannot spell the same ids differently.
 */
export const eventIdentityOf = (context: DispatchContext) => ({
  runId: context.runId as string,
  sessionId: sessionIdOf(context) as string,
  spanId: context.spanId,
  taskId: taskIdOf(context) as string | null,
  threadId: threadIdOf(context) as string | null,
  traceId: context.traceId,
  workspaceId: workspaceIdOf(context) as string,
});

/** The three ways a run ends. */
export const RUN_TERMINUS_KINDS = ["finished", "failed", "lost"] as const;

/** How a run ended, as the discriminator of {@link RunTerminus}. */
export type RunTerminusKind = (typeof RUN_TERMINUS_KINDS)[number];

/**
 * What every ending reports, whether or not it produced numbers.
 *
 * The economics are nullable throughout and stay null on a degraded ending: an
 * interrupted run did not cost $0.00 and did not take 0ms, and a fabricated
 * zero is a number someone later averages. `finalText` is the last assistant
 * message and is what the message fallback appends when the run posted no
 * message of its own; it is empty rather than null when the run said nothing,
 * because "said nothing" is a length, not an absence.
 */
interface RunTerminusBase {
  readonly costUsd: CostUsd | null;
  readonly durationMs: number | null;
  /** Null where the container was killed before it could produce one. */
  readonly exitCode: number | null;
  readonly finalText: string;
  /** Null where the provider never named one, which is every crash before the first turn. */
  readonly providerSessionId: string | null;
  readonly totalTokens: number | null;
  readonly turns: number | null;
}

/** The clean finish: a terminal event saying the turn is done. */
export interface RunFinished extends RunTerminusBase {
  readonly kind: "finished";
}

/**
 * The failure: a terminal event that named an error, or a stage of the loop
 * that failed before or around one. The class is already the classified name
 * and the message is already sanitized — see `describeFailure`.
 */
export interface RunFailed extends RunTerminusBase {
  readonly errorClass: RunErrorClass;
  readonly errorMessage: string;
  /**
   * Why this run was ended from outside it, or null where it failed on its own.
   *
   * Carried on the terminus rather than inferred from `errorClass` because the
   * class cannot answer it: `Interrupted` is one name for a person pressing
   * Stop, a newer prompt taking the session over, and the loop going down under
   * a run, and those are three different things to go and look at. Null is also
   * an answer — an interrupt nothing recorded a reason for is filed as one
   * rather than attributed to whichever of the three seemed likely.
   */
  readonly interruptReason: InterruptReason | null;
  readonly kind: "failed";
}

/**
 * Who asked for a run to stop, and why. Written by the loop the instant before
 * it interrupts the fiber, read by that run's own close as it unwinds — which
 * is the only moment both facts are in one place, because an interrupt carries
 * no payload of its own and `Cause.squash` renders an interrupts-only cause as
 * a bare `Error("All fibers interrupted without error")`. Filing that through
 * the ordinary classifier is what made a person's stop arrive on the row as
 * `errored / Unknown`.
 */
export interface StopNote {
  readonly reason: InterruptReason;
  /** The actor the command row named, or null where nothing named one. */
  readonly requestedBy: ActorKind | null;
}

/** How each actor is named in the sentence a stopped run's row carries. */
const REQUESTER_PHRASE = {
  human: "a person",
  manager: "the manager agent",
  orchestrator: "the orchestrator",
  system: "the system",
  worker_run: "a worker run",
} as const satisfies Record<ActorKind, string>;

/** What a stopped run's `errorMessage` says: which of the three, and who asked. */
export const stopMessageOf = (note: StopNote | null) => {
  if (note === null) {
    return "the run was interrupted, and nothing recorded who asked";
  }
  switch (note.reason) {
    case "stopped":
      return `stopped by ${note.requestedBy === null ? "a stop command" : REQUESTER_PHRASE[note.requestedBy]}`;
    case "superseded":
      return "superseded by a newer prompt on the same session";
    default:
      return "the loop shut down under this run";
  }
};

/**
 * The process went away without a terminus. Its own ending rather than a
 * failure, because the two are answered differently: a failure has a reason to
 * put in the crash message, and this one has only a count of how far the stream
 * got before it stopped — which is what distinguishes a container that never
 * started from one that died halfway.
 */
export interface RunLost extends RunTerminusBase {
  readonly eventsSeen: number;
  readonly kind: "lost";
}

/**
 * How a run ended. Every terminal path produces exactly one of these, and the
 * task transition, the run row and the wide event all read it — so they cannot
 * disagree about whether a run failed.
 */
export type RunTerminus = RunFailed | RunFinished | RunLost;

/** What only a lost run knows, on top of the text and the ids it may still have. */
export interface LostTerminusInput {
  readonly eventsSeen: number;
  readonly exitCode: number | null;
  readonly finalText: string;
  readonly providerSessionId: string | null;
}

/**
 * A lost ending, with the economics nulled. A constructor rather than an object
 * literal at four call sites, because the nulls are the rule: a run nobody
 * heard from reported no cost, no duration, no tokens and no turns, and the one
 * place that is easy to get wrong is the path where the numbers are already in
 * scope from an earlier partial reading.
 */
export const lostTerminus = (input: LostTerminusInput): RunLost => ({
  costUsd: null,
  durationMs: null,
  eventsSeen: input.eventsSeen,
  exitCode: input.exitCode,
  finalText: input.finalText,
  kind: "lost",
  providerSessionId: input.providerSessionId,
  totalTokens: null,
  turns: null,
});

/** Whether this ending is anything other than a clean finish. */
export const isFailure = (terminus: RunTerminus) =>
  terminus.kind !== "finished";

/**
 * What the harness calls a turn ended from outside it. The class every
 * interrupt carries onto a row, whichever of the three it was — declared here,
 * beside the union that reads it, so the constructor and the readers cannot
 * spell it differently.
 */
export const INTERRUPTED_CLASS = "Interrupted";

/**
 * Whether this run was ended from outside rather than by anything going wrong
 * inside it: a stop command, a newer prompt taking the session over, the loop
 * shutting down, or an interrupt nothing recorded a reason for.
 *
 * Read wherever "did this fail" is the wrong question. The thread gets a notice
 * rather than a crash report, and the session is left resumable — a person who
 * presses Stop and then Rerun is continuing a conversation, not starting over
 * from a wreck, and a session marked `failed` is one nothing may pick up again.
 */
export const isInterrupt = (terminus: RunTerminus) =>
  terminus.kind === "failed" && terminus.errorClass === INTERRUPTED_CLASS;

/**
 * The domain outcome a run row records. Total over the union: a clean finish is
 * `done`, a silent process is `lost`, and a failure is whatever its
 * classification says — which is how a run that outlived its cap lands as
 * `timeout` rather than as `errored`.
 *
 * A deliberate stop is the one ending the class cannot answer alone, because
 * all three interrupts share the class `Interrupted`. Somebody asking for this
 * run to end is `stopped`; the loop going down under it, or an interrupt with
 * no reason recorded, stays `interrupted`.
 */
export const outcomeOfTerminus = (terminus: RunTerminus): RunOutcome => {
  switch (terminus.kind) {
    case "finished":
      return "done";
    case "lost":
      return "lost";
    default:
      return terminus.interruptReason === "stopped"
        ? "stopped"
        : runOutcomeOfClass(terminus.errorClass);
  }
};

/**
 * The two error columns of the run row and the wide event. Null on a clean
 * finish; on a lost run the class is the harness's name for the same fact seen
 * from the other end, so the two vocabularies agree without a mapping table.
 */
export const errorFieldsOf = (terminus: RunTerminus) => {
  switch (terminus.kind) {
    case "finished":
      return { errorClass: null, errorMessage: null } as const;
    case "lost":
      return {
        errorClass: "NoTerminalEvent",
        errorMessage: `the run produced ${terminus.eventsSeen} events and no terminus`,
      } as const;
    default:
      return {
        errorClass: terminus.errorClass,
        errorMessage: terminus.errorMessage,
      } as const;
  }
};

/** The economics as the run row and the wide event hold them, nulls included. */
export const economicsOf = (terminus: RunTerminus) => ({
  costUsd: terminus.costUsd,
  durationMs: terminus.durationMs,
  totalTokens: terminus.totalTokens,
  turns: terminus.turns,
});
