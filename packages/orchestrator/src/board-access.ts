/**
 * Whether the run could still reach the board when it stopped.
 *
 * **The failure this exists for is silent from both ends.** A worker whose
 * credential has expired gets a `401` per tool call, and a `401` is not an
 * error the model fails on — it narrates it, writes what it can to disk, and
 * ends its turn cleanly. The provider reports `done`, the run row records a
 * clean finish, and the card shows a run that produced nothing. Nobody is
 * paged, because from every row's point of view the run worked.
 *
 * So the signal is taken from the one place it exists: the run's own event
 * stream, which the loop is already reading to know whether a message was
 * posted. A board tool that answers proves the credential is live; a board tool
 * refused on the credential proves it is not. That is a fact about the run
 * worth a column, and {@link boardFailureOf} turns it into the ending the card
 * shows.
 *
 * **Two vocabularies, neither of them restated here.** Which tools are the
 * board's is `AGENT_TOOL_PREFIX`, the prefix the MCP server is actually
 * mounted under; which refusals are about the credential is `TOKEN_REJECTIONS`
 * under the `token_` spelling the gateway's own `deny` builds. Both are
 * imported rather than copied, because a prefix or a reason spelled a second
 * time here is a detector that stops detecting the day either is renamed.
 *
 * **Only the credential counts.** A `NotFound` on a task id the model invented
 * and a `Forbidden` on a task that is not this run's are both the agent being
 * wrong, and the board answered them — reading either as lost access would
 * report a working gateway as a broken one. What is watched for is the narrow
 * case where the request never reached an authorization decision at all.
 *
 * **Access is a latch that opens again.** A run that is refused and then
 * succeeds has not lost the board; it hit one bad call. Only a run whose *last*
 * board call was refused ends as one that could not write, which is what keeps
 * a transient refusal from failing an otherwise healthy run.
 */

import { AGENT_TOOL_PREFIX } from "@workspace/agent-tools";
import type { AgentEvent } from "@workspace/harness";
import { clipError } from "@workspace/telemetry";
import { TOKEN_REJECTIONS } from "@workspace/token";

/**
 * The class a run ending with no board access carries onto its row and its
 * crash message.
 *
 * Its own name rather than the harness's `Unauthenticated`, which means the
 * provider login failed rather than the board one. The two are answered by
 * different people — one is a re-login on the host, this one is the loop
 * failing to keep the run's credential alive on the mount — and a `GROUP BY
 * errorClass` that cannot tell them apart sends every one of these to the wrong
 * place.
 */
export const BOARD_ACCESS_ERROR_CLASS = "BoardAccessLost";

/** Whether this tool name is one of the board tools a run is given. */
export const isBoardTool = (toolName: string) =>
  toolName.startsWith(AGENT_TOOL_PREFIX);

/**
 * How the gateway spells a rejected token onto the refusal a caller reads —
 * `deny(attempt, \`token_${rejected.reason}\`)` in the gateway's own principal
 * resolution. Derived from the closed set rather than listing the ones that
 * seem likely, so a new rejection reason is covered the day it is added.
 */
const TOKEN_REASONS = TOKEN_REJECTIONS.map((reason) => `token_${reason}`);

/**
 * What a refusal about the credential looks like by the time it is the text of
 * a tool result.
 *
 * The chain is worth stating once: the gateway fails `Unauthorized({reason})`,
 * the tool renders it through `describeFailure` as `Unauthorized: {"reason":
 * "token_expired"}`, and the harness clips that into the result's summary. So
 * either half is enough to recognize it, and matching on either is what keeps
 * this working if one of the two renderings changes.
 */
const AUTH_FAILURE_PATTERN = new RegExp(
  ["Unauthorized", ...TOKEN_REASONS].join("|"),
  "i"
);

/** Whether a failed tool result was refused on the credential rather than on the request. */
export const isBoardAuthFailure = (summary: string) =>
  AUTH_FAILURE_PATTERN.test(summary);

/**
 * What the run has proved about its own board access so far.
 *
 * `refusals` is a count and not a flag because the two answer different
 * questions: whether the run ended able to write is `lost`, and how much of the
 * run was spent unable to is the count — a run refused once at the end lost a
 * message, a run refused two hundred times lost its whole second half.
 */
export interface BoardAccess {
  /** The refusal, as the model saw it. Null until one happens; kept for the card. */
  readonly detail: string | null;
  /** Whether the most recent board call was refused on the credential. */
  readonly lost: boolean;
  /** Board calls still waiting on a result, by call id. */
  readonly pending: readonly string[];
  /** How many board calls were refused on the credential over the whole run. */
  readonly refusals: number;
}

/** A run that has not called a board tool yet, which is a run holding the board. */
export const BOARD_ACCESS_HELD: BoardAccess = {
  detail: null,
  lost: false,
  pending: [],
  refusals: 0,
};

/**
 * The board calls this event starts, if it starts one.
 *
 * A call is remembered by id because the name is on the call and the outcome is
 * on the result, and nothing carries both. Ids are dropped as their results
 * arrive, so a run that makes thousands of board calls holds only the ones
 * genuinely in flight.
 */
const started = (access: BoardAccess, callId: string): BoardAccess => ({
  ...access,
  pending: [...access.pending, callId],
});

/** The state after a board call answered, whichever way it answered. */
const settled = (input: {
  readonly access: BoardAccess;
  readonly callId: string;
  readonly ok: boolean;
  readonly summary: string;
}): BoardAccess => {
  const { access, callId, ok, summary } = input;
  const pending = access.pending.filter((id) => id !== callId);
  if (ok) {
    // The credential is live, whatever happened before. This is the only thing
    // that clears the latch, and it has to: a run that recovers is a run that
    // did not lose the board.
    return { ...access, detail: null, lost: false, pending };
  }
  if (!isBoardAuthFailure(summary)) {
    // The board answered and said no. That is the agent's problem, not the
    // credential's, and it says nothing about whether the next call will land.
    return { ...access, pending };
  }
  return {
    detail: clipError(summary),
    lost: true,
    pending,
    refusals: access.refusals + 1,
  };
};

/**
 * Folds one event into what the run has proved about its board access. Pure and
 * total over the harness's union, so the whole detector is testable without a
 * provider, a gateway or a container.
 */
export const observeBoardAccess = (
  access: BoardAccess,
  event: AgentEvent
): BoardAccess => {
  if (event.kind === "tool_call") {
    return isBoardTool(event.toolName) ? started(access, event.callId) : access;
  }
  if (event.kind === "tool_result" && access.pending.includes(event.callId)) {
    return settled({
      access,
      callId: event.callId,
      ok: event.ok,
      summary: event.summary,
    });
  }
  return access;
};

/** The two error columns a run that could not write to the board carries. */
export interface BoardFailure {
  readonly errorClass: typeof BOARD_ACCESS_ERROR_CLASS;
  readonly errorMessage: string;
}

/**
 * How this run failed on the board, or null where it did not.
 *
 * The message is written for the person reading the card rather than for a
 * query: it says what stopped working, how many calls it cost, and — because
 * the handoff is the other half of this fix — that the run's own words are
 * attached separately rather than lost.
 */
export const boardFailureOf = (access: BoardAccess): BoardFailure | null => {
  if (!access.lost) {
    return null;
  }
  const refused = `${access.refusals} board ${access.refusals === 1 ? "call was" : "calls were"} refused on this run's credential`;
  const detail = access.detail === null ? "" : `: ${access.detail}`;
  return {
    errorClass: BOARD_ACCESS_ERROR_CLASS,
    errorMessage: clipError(
      `the run could not write to the board — ${refused}${detail}. Anything it wrote to its artifacts directory survived the container.`
    ),
  };
};
