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
import type { RunTerminus } from "./dispatch-context";
import { describeFailure } from "./errors";
import { isCommentTool } from "./terminal";

/** What the harness calls an error it could not name. Used where a result reports none. */
const UNNAMED_ERROR = "Unknown";

/**
 * What one turn has said so far, and what it means for how the run ends.
 */
export interface TurnProgress {
  /** The branch the checkout pushed, learned at materialization. */
  readonly branch: string | null;
  /** True once a comment tool has answered successfully. */
  readonly commentPosted: boolean;
  /** The next line ordinal, which is the next `seq`. */
  readonly eventsSeen: number;
  /** The last assistant message, which is what the fallback comment appends. */
  readonly finalText: string;
  /** Comment-tool calls still waiting on their result, by call id. */
  readonly pendingComments: readonly string[];
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
  branch: null,
  commentPosted: false,
  eventsSeen: 0,
  finalText: "",
  pendingComments: [],
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
    kind: "failed",
    providerSessionId: progress.providerSessionId,
    totalTokens: null,
    turns: null,
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
  const seen = { ...progress, eventsSeen: progress.eventsSeen + 1 };
  switch (event.kind) {
    case "session_init":
      return { ...seen, providerSessionId: event.providerSessionId };
    case "assistant_text":
      return { ...seen, finalText: event.text };
    case "tool_call":
      return isCommentTool(event.toolName)
        ? {
            ...seen,
            pendingComments: [...seen.pendingComments, event.callId],
          }
        : seen;
    case "tool_result":
      return event.ok && seen.pendingComments.includes(event.callId)
        ? {
            ...seen,
            commentPosted: true,
            pendingComments: seen.pendingComments.filter(
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
