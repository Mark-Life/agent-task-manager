/**
 * The rule that a run has to say something before it is allowed to stop, and
 * the wire contract both harnesses speak to enforce it.
 *
 * Claude and Codex each fire a hook when the agent tries to end its turn. The
 * hook is handed the final assistant message and may refuse the ending; the
 * refusal reason is fed back to the model as its next prompt. So "this run
 * finished without posting a comment" turns from a thing noticed afterwards
 * into a thing corrected during the turn.
 *
 * One script serves both harnesses because the two payloads are the same
 * payload. Claude sends `session_id`, `transcript_path`, `cwd`,
 * `hook_event_name: "Stop"`, `stop_hook_active` and an optional
 * `last_assistant_message`; Codex sends all of those — with `transcript_path`
 * and `last_assistant_message` explicitly nullable rather than absent — plus
 * `model`, `permission_mode` and `turn_id` of its own. The response is the same
 * on both sides: `{ decision: "block", reason }` refuses, anything else allows,
 * and Codex additionally rejects a block whose reason is empty. One schema
 * covers both, with the differences typed as optional rather than papered over.
 *
 * **The rule is about a turn that has a task.** A manager turn answers in a
 * conversation and has no card to comment on, so the hook is never registered
 * on one — see {@link commentRuleApplies}, which is what the entrypoint asks
 * before it names the command. {@link decideStop} itself stays unconditional:
 * it is the rule for a turn the rule applies to, and a second "does this
 * count" test inside it would be the same question answered in two places.
 *
 * Everything here is pure. The decision takes a parsed payload and a boolean;
 * reading stdin, the marker file and the clock belongs to the executable in
 * `scripts/`, so the rule itself can be tested without a provider.
 *
 * Two limits worth knowing before trusting this. The retry is capped at one:
 * both harnesses set `stop_hook_active` when the turn is already the product of
 * an earlier refusal, and neither enforces a limit for you, so a hook that
 * refuses unconditionally is an agent that never ends. And on a *failed* Codex
 * turn the hook does not run at all — enforcement covers clean completion only,
 * which is why the orchestrator's auto-append fallback stays in place regardless.
 */

import { join } from "node:path";
import { HANDOFF_FILENAME } from "@workspace/domain";
import { Option, Schema } from "effect";
import { trimmedOrNull } from "./env";
import { containerRunLayout, type RunLayout } from "./paths";
import type { TurnSpecIdentity } from "./turn-spec";

/**
 * The file whose existence means this run posted a comment.
 *
 * The hook runs inside the sandbox with no database handle and no gateway
 * token, so the question has to be answerable from the filesystem alone. The
 * answer is this file, and existence is the whole protocol: the contents are
 * never read, so `touch` is a complete implementation and a half-written file
 * cannot be misread.
 *
 * Whoever observes the comment being posted creates it. In the normal path that
 * is the orchestrator, which streams this run's normalized events, sees the
 * comment tool's `tool_result`, and creates the file on the host — the container
 * sees it immediately through the same mount. A provider that wires the comment
 * tool in-process may create it directly instead. Neither party needs to know
 * about the other, because both mean the same file.
 */
export const COMMENT_MARKER_FILE = "comment-posted";

/**
 * Overrides where {@link commentMarkerPath} looks. Set by the orchestrator when
 * the run directory is mounted somewhere other than the standard container
 * path — a local run outside a container being the usual reason.
 */
export const COMMENT_MARKER_ENV_VAR = "ATM_COMMENT_MARKER";

/**
 * The marker for a run, under whichever root is looking. It sits in the run
 * directory beside the event log rather than in the agent home, because the
 * agent home belongs to a vendor that rewrites it and the run directory is ours.
 */
export const commentMarkerPathOf = (layout: RunLayout) =>
  join(layout.runDir, COMMENT_MARKER_FILE);

/**
 * The marker as the hook process sees it: the override when it is set, and the
 * container's own run directory otherwise. The default is what makes the hook
 * work with no environment wiring at all inside a standard sandbox.
 */
export const commentMarkerPath = (
  env: Readonly<Record<string, string | undefined>>
) =>
  trimmedOrNull(env[COMMENT_MARKER_ENV_VAR]) ??
  commentMarkerPathOf(containerRunLayout);

/**
 * Whether this turn is one the comment rule is about at all.
 *
 * The rule is "post a comment on your task", and a manager turn has no task: it
 * answers in a conversation, and the orchestrator writes that answer back when
 * the turn ends. Registering the hook on one produces a refusal the agent has
 * no way to obey — {@link NO_COMMENT_REFUSAL} arrives as its next prompt, names
 * a task that does not exist, and the turn is spent explaining that it will not
 * post onto an unrelated card to satisfy a hook. That is what a person reading
 * the chat sees, and it is the whole of this bug.
 *
 * Read off the turn's own identity rather than off a role flag, because
 * `taskId` being null *is* the fact the rule turns on: there is nothing to
 * comment on. A container started by hand with a taskless spec gets the same
 * answer for the same reason.
 */
export const commentRuleApplies = (
  identity: Pick<TurnSpecIdentity, "taskId">
) => identity.taskId !== null;

/**
 * Names the command each provider registers as its stop hook. The path of the
 * executable is a property of the image, not of this package, so the sandbox
 * sets it and the providers read it rather than either of them composing a path
 * that the other has to match.
 */
export const STOP_HOOK_COMMAND_ENV_VAR = "ATM_STOP_HOOK_COMMAND";

/**
 * The stop-hook command to register, or null when none is configured. Absence
 * is not an error: a run outside a sandbox has no hook, and the orchestrator's
 * comment fallback covers the same rule from the other side.
 */
export const stopHookCommand = (
  env: Readonly<Record<string, string | undefined>>
) => trimmedOrNull(env[STOP_HOOK_COMMAND_ENV_VAR]);

/**
 * What the harness sends when the agent tries to end its turn.
 *
 * Required fields are the ones both harnesses always send. Optional ones are
 * either a Codex extension or a field Claude omits rather than nulls; a value
 * that is `null` on one side and absent on the other is typed as both, so the
 * schema never has to guess which harness it is reading.
 *
 * Unknown keys are ignored on decode, which is deliberate: Claude adds
 * `background_tasks`, `session_crons`, `prompt_id` and `effort`, and a new one
 * next release should not be a hook that starts failing.
 */
export const StopHookPayload = Schema.Struct({
  /** The agent's working directory. Both harnesses, always. */
  cwd: Schema.String,
  /**
   * Always `Stop`. Registering this script on any other event — Codex's
   * `SubagentStop`, for instance — decodes to nothing and therefore allows,
   * which is the safe direction for a mis-wired hook.
   */
  hook_event_name: Schema.Literal("Stop"),
  /**
   * The final assistant message. Claude omits the key when there is none;
   * Codex sends the key with `null`. Not read by the rule below — the message
   * is the orchestrator's fallback comment, not evidence that one was posted.
   */
  last_assistant_message: Schema.optional(Schema.NullOr(Schema.String)),
  /** Codex only, and Codex always sends it. */
  model: Schema.optional(Schema.String),
  /** `default`, `acceptEdits`, `plan`, `dontAsk`, `bypassPermissions`. */
  permission_mode: Schema.optional(Schema.String),
  /** The provider's own session id, the same one the turn's events carry. */
  session_id: Schema.String,
  /**
   * True when this turn exists because an earlier stop was refused. The entire
   * basis of the retry cap — see {@link decideStop}.
   */
  stop_hook_active: Schema.Boolean,
  /** Where the harness is writing this session's transcript. Codex may send null. */
  transcript_path: Schema.optional(Schema.NullOr(Schema.String)),
  /** Codex only: the id of the turn the hook fired inside. */
  turn_id: Schema.optional(Schema.String),
});

export interface StopHookPayload
  extends Schema.Schema.Type<typeof StopHookPayload> {}

/**
 * What the harness reads back. `decision: "block"` is the refusal and `reason`
 * becomes the agent's next prompt; everything else lets the turn end. Both
 * harnesses accept this shape, and both treat a block with an empty reason as a
 * malformed response rather than a refusal, so the two always travel together.
 */
export const StopHookResponse = Schema.Struct({
  /** False aborts the whole run. Never sent by this hook — refusing a turn is not killing a run. */
  continue: Schema.optional(Schema.Boolean),
  decision: Schema.optional(Schema.Literal("block")),
  /** Required whenever `decision` is set, and read by the model as its next prompt. */
  reason: Schema.optional(Schema.String),
  /** Shown to the operator rather than to the model, so a refusal is visible in the transcript. */
  systemMessage: Schema.optional(Schema.String),
});

export interface StopHookResponse
  extends Schema.Schema.Type<typeof StopHookResponse> {}

/**
 * Why a turn was allowed to end. Three literals rather than a boolean, because
 * "the run commented" and "the run ignored us and we are out of retries" are
 * the same response and very different facts about the run.
 */
export const STOP_ALLOW_REASONS = [
  "comment_posted",
  "retry_spent",
  "unreadable_payload",
] as const;

/** The ground for allowing a turn to end. */
export const StopAllowReason = Schema.Literals(STOP_ALLOW_REASONS);
export type StopAllowReason = typeof StopAllowReason.Type;

/** The turn may end, and the reason it was let through. */
export interface StopAllowed {
  readonly kind: "allow";
  readonly why: StopAllowReason;
}

/** The turn may not end; `reason` is what the agent reads next. Never empty. */
export interface StopRefused {
  readonly kind: "refuse";
  readonly reason: string;
}

/** What the rule decided about one attempted turn end. */
export type StopDecision = StopAllowed | StopRefused;

/**
 * What the agent is told when it tries to finish without having commented.
 * Written as an instruction with a stopping condition, because it arrives as a
 * prompt and an agent that reads it as criticism will apologize instead of
 * writing the comment.
 *
 * The brevity clause is here because this text can be the last word on what a
 * comment is: it arrives as a prompt at the moment one is being written, and
 * without it the naming of three topics and nothing about size reads as an
 * invitation to cover all three at length. `WORKER_RULES` in
 * `@workspace/prompts` says the same thing first and says it more fully — this
 * is the short form of one rule, not a second rule.
 *
 * The last sentence is the escape, and it is here rather than only in the
 * prompt because this text arrives at the exact moment it is needed: an agent
 * whose board tools have stopped answering reads "post one now" as an
 * instruction it has already tried and cannot follow, and what it does next is
 * either burn its remaining turn retrying a dead tool or end without the
 * comment anyway. Naming the file gives the refusal something to be complied
 * with. The name is `HANDOFF_FILENAME`, which `@workspace/orchestrator` reads
 * back off the task's artifacts directory — one convention, three packages, no
 * second spelling.
 */
export const NO_COMMENT_REFUSAL = `This run has not posted a comment on its task. Post one now — what you did, what changed, and anything the next session or a human reviewer needs to know — then end your turn. Keep it short: link to what holds the detail rather than restating it here. Do not repeat work you have already finished. If the tool that posts comments is not answering, write the same text to \`${HANDOFF_FILENAME}\` in your artifacts directory instead and end your turn; it is read off the disk and posted for you.`;

/** The allowing response. One object, because it carries no per-decision detail. */
export const ALLOW_TURN_END: StopHookResponse = { continue: true };

/** What the rule is asked about: one attempted turn end, and what the run has done so far. */
export interface StopDecisionInput {
  /** Whether this run has posted a comment, as the marker file reports it. */
  readonly commentPosted: boolean;
  /** The decoded payload, or null when it could not be read. */
  readonly payload: StopHookPayload | null;
}

/**
 * Whether this turn may end. Pure, total, and fail-open at every step that
 * could go wrong.
 *
 * The order is the rule. An unreadable payload allows, because a hook that
 * cannot parse its own input must not be the thing that wedges a run. A posted
 * comment allows and says so, which is also what a successful enforcement looks
 * like on the second pass. `stop_hook_active` allows next: the harness sets it
 * on a turn that only exists because we already refused once, so refusing again
 * is a loop neither harness will break for us. Only a first attempt with no
 * comment is refused.
 */
export const decideStop = ({
  commentPosted,
  payload,
}: StopDecisionInput): StopDecision => {
  if (payload === null) {
    return { kind: "allow", why: "unreadable_payload" };
  }
  if (commentPosted) {
    return { kind: "allow", why: "comment_posted" };
  }
  if (payload.stop_hook_active) {
    return { kind: "allow", why: "retry_spent" };
  }
  return { kind: "refuse", reason: NO_COMMENT_REFUSAL };
};

/** The wire response for a decision. The only place the block shape is written. */
export const stopHookResponseOf = (decision: StopDecision): StopHookResponse =>
  decision.kind === "allow"
    ? ALLOW_TURN_END
    : {
        decision: "block",
        reason: decision.reason,
        systemMessage: "stop refused: the run has posted no comment",
      };

/** Decoder over the payload, built once — it compiles an AST on every call otherwise. */
const decodePayload = Schema.decodeUnknownOption(StopHookPayload);

/**
 * The payload a harness sent, or null when the input is not one. Null rather
 * than a thrown error or a typed failure: the only caller is a hook process
 * whose answer to every unreadable input is the same, and {@link decideStop}
 * takes that null directly so the fail-open path is covered by the same tests
 * as the rest of the rule.
 */
export const parseStopHookPayload = (input: unknown) =>
  Option.getOrNull(decodePayload(input));
