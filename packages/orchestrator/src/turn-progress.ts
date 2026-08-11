/**
 * What one turn has produced so far, and the three endings it can produce.
 *
 * Pure and separate from the lifecycle for one reason: the terminal path runs
 * from an `onExit`, so the accumulator has to outlive the fiber that filled it.
 * It is carried in a `Ref` the lifecycle owns and read again after an interrupt,
 * a crash, or a clean finish — which is what lets all three close a run out with
 * whatever was known at the moment it stopped.
 *
 * Named apart from `./run-telemetry`'s `RunProgress`, which accumulates the
 * fields of the wide event. This one accumulates the facts the *rows* need.
 */

import type { AgentEvent } from "@workspace/harness";
import { clipError } from "@workspace/telemetry";
import {
  BOARD_ACCESS_HELD,
  type BoardAccess,
  boardFailureOf,
  observeBoardAccess,
} from "./board-access";
import {
  INTERRUPTED_CLASS,
  type RunTerminus,
  type StopNote,
  stopMessageOf,
} from "./dispatch-context";
import { describeFailure, interruptReasonOf } from "./errors";
import { isMessageTool } from "./terminal";

/** What the harness calls an error it could not name. Used where a result reports none. */
const UNNAMED_ERROR = "Unknown";

/**
 * What one turn has said so far, and what it means for how the run ends.
 */
export interface TurnProgress {
  /**
   * Whether the run could still write to the board, as its own tool calls
   * proved it. Read at the close: a run that ended unable to write ends failed
   * rather than quietly clean — see `./board-access`.
   */
  readonly boardAccess: BoardAccess;
  /** The branch the checkout pushed, learned at materialization. */
  readonly branch: string | null;
  /** The next line ordinal, which is the next `seq`. */
  readonly eventsSeen: number;
  /** The last assistant message, which is what the fallback message appends. */
  readonly finalText: string;
  /** True once a message tool has answered successfully. */
  readonly messagePosted: boolean;
  /** Message-tool calls still waiting on their result, by call id. */
  readonly pendingMessages: readonly string[];
  /**
   * How much prompt this turn was given. Measured here rather than recomputed
   * later because the prompt is built inside the run's own scope and never
   * leaves it — the ingest and the wide event both want the number, and neither
   * should hold the text to get it. Null until the prompt exists, which is
   * every failure before it was assembled.
   */
  readonly promptChars: number | null;
  readonly providerSessionId: string | null;
  /** Set by the one terminal event. Null here is what `lost` means. */
  readonly terminus: RunTerminus | null;
}

/** A turn that has not said anything yet. The seed the lifecycle starts from. */
export const EMPTY_TURN_PROGRESS: TurnProgress = {
  boardAccess: BOARD_ACCESS_HELD,
  branch: null,
  eventsSeen: 0,
  finalText: "",
  messagePosted: false,
  pendingMessages: [],
  promptChars: null,
  providerSessionId: null,
  terminus: null,
};

/**
 * The terminus a `result` event is. Whatever economics it carried are passed
 * through untouched, nulls included: the harness already nulls them on its
 * degraded outcomes, and re-deciding here is how the run row and the turn's own
 * ledger row come to disagree about what a turn cost.
 */
export const terminusOfResult = (
  event: Extract<AgentEvent, { readonly kind: "result" }>
): RunTerminus => {
  const shared = {
    costUsd: event.costUsd,
    durationMs: event.durationMs,
    // Nothing outside a container produces an exit code, and a fabricated 0
    // would read as a clean process exit.
    exitCode: null,
    finalText: event.text,
    providerSessionId: event.providerSessionId,
    totalTokens: event.totalTokens,
    turns: event.turns,
  };
  return event.outcome === "done"
    ? { ...shared, kind: "finished" }
    : {
        ...shared,
        errorClass: event.errorClass ?? UNNAMED_ERROR,
        errorMessage: clipError(
          event.errorMessage ?? `the turn ended ${event.outcome}`
        ),
        // The turn inside the container reports that it was interrupted, never
        // by whom: the command that asked is a row on the host, and only the
        // loop holds it. Null is the honest answer here.
        interruptReason: null,
        kind: "failed",
      };
};

/** The terminus a failure anywhere in the run is, with the economics left null. */
export const terminusOfFailure = (
  failure: unknown,
  progress: TurnProgress
): RunTerminus => {
  const { errorClass, errorMessage } = describeFailure(failure);
  return {
    costUsd: null,
    durationMs: null,
    errorClass,
    errorMessage,
    exitCode: null,
    finalText: progress.finalText,
    // A `Harness.Interrupted` already says why it was interrupted, so a failure
    // that arrives typed keeps its reason rather than being re-derived from the
    // sentence it was rendered into.
    interruptReason: interruptReasonOf(failure),
    kind: "failed",
    providerSessionId: progress.providerSessionId,
    totalTokens: null,
    turns: null,
  };
};

/**
 * The terminus an interrupt is, named by whoever asked for it.
 *
 * Its own constructor rather than `terminusOfFailure` over a squashed cause,
 * because an interrupts-only cause carries nothing to classify: Effect renders
 * it as `Error("All fibers interrupted without error")`, which matches no
 * anchor, comes back `Unknown`, and files a person's Stop as a system failure.
 * The note is the loop's own record of the interrupt it is about to cause, and
 * it is the only thing that can tell a stop from a shutdown here.
 *
 * The economics stay null exactly as they do for a failure: what this run had
 * spent by the moment it was killed is in the `atm.turn` rows its container
 * wrote, and the close reads those back rather than guessing here.
 */
export const terminusOfStop = (input: {
  readonly note: StopNote | null;
  readonly progress: TurnProgress;
}): RunTerminus => ({
  costUsd: null,
  durationMs: null,
  errorClass: INTERRUPTED_CLASS,
  errorMessage: stopMessageOf(input.note),
  exitCode: null,
  finalText: input.progress.finalText,
  interruptReason: input.note?.reason ?? null,
  kind: "failed",
  providerSessionId: input.progress.providerSessionId,
  totalTokens: null,
  turns: null,
});

/**
 * The ending a run actually had, once what it could not write is accounted for.
 *
 * A run that spent its last hour being refused by the board still reports
 * `done`: the model was never blocked, it simply narrated the refusals and
 * stopped. That is the failure this whole path exists to stop being invisible,
 * so a clean finish with no board access is rewritten as the failure it was —
 * which is what puts the reason on the card, through the same crash message
 * every other failure takes.
 *
 * Only a clean finish is rewritten. A run that already failed has a reason of
 * its own and it is the more useful one — a container that was OOM-killed also
 * stopped writing to the board, and reporting that as a credential problem
 * sends the reader somewhere there is nothing to find. A lost run is left alone
 * for the same reason: `lost` is already the loudest thing a row can say.
 */
export const terminusWithBoardAccess = (input: {
  readonly progress: TurnProgress;
  readonly terminus: RunTerminus;
}): RunTerminus => {
  const { progress, terminus } = input;
  if (terminus.kind !== "finished") {
    return terminus;
  }
  const failure = boardFailureOf(progress.boardAccess);
  return failure === null
    ? terminus
    : {
        ...terminus,
        ...failure,
        // Nobody ended this run: it finished, having spent part of itself
        // talking to a board that would not answer. That is a fault of its own
        // and not an interrupt.
        interruptReason: null,
        kind: "failed",
      };
};

/**
 * What one event changes about the run. Pure, and total over the harness's
 * union by way of its default: most kinds are timeline entries and nothing
 * else, and only the five below say something about how the run ends.
 */
export const observeTurn = (
  progress: TurnProgress,
  event: AgentEvent
): TurnProgress => {
  const seen = {
    ...progress,
    // Folded on every event rather than in the `tool_result` branch below,
    // because that branch is about the message tool specifically and this is
    // about all of them — including the calls a run makes after it has already
    // posted, which are exactly the ones a late expiry takes out.
    boardAccess: observeBoardAccess(progress.boardAccess, event),
    eventsSeen: progress.eventsSeen + 1,
  };
  switch (event.kind) {
    case "session_init":
      return { ...seen, providerSessionId: event.providerSessionId };
    case "assistant_text":
      return { ...seen, finalText: event.text };
    case "tool_call":
      return isMessageTool(event.toolName)
        ? {
            ...seen,
            pendingMessages: [...seen.pendingMessages, event.callId],
          }
        : seen;
    case "tool_result":
      return event.ok && seen.pendingMessages.includes(event.callId)
        ? {
            ...seen,
            messagePosted: true,
            pendingMessages: seen.pendingMessages.filter(
              (callId) => callId !== event.callId
            ),
          }
        : seen;
    case "result":
      return {
        ...seen,
        finalText: event.text.length > 0 ? event.text : seen.finalText,
        providerSessionId: event.providerSessionId ?? seen.providerSessionId,
        terminus: terminusOfResult(event),
      };
    default:
      return seen;
  }
};
