/**
 * When a live run has stopped getting anywhere, decided from the run's own
 * event stream and nothing else.
 *
 * A run that is genuinely working edits files. One that has lost the thread
 * keeps calling tools — listing the same directory, reading the same file,
 * grepping the same pattern — and changes nothing. That is the whole shape this
 * rule looks for: many tool calls, no file edits, and almost no variety in what
 * the calls were.
 *
 * The evidence is `run_event` rows, which are already the record of what an
 * agent did. Nothing here counts anything a second time: no counter table, no
 * per-run tally kept beside the timeline that could disagree with it. A verdict
 * is a function of the rows in a window, so the same rows always give the same
 * answer and a test can hand it a sequence directly.
 *
 * Every threshold arrives as an argument. A number written into the detection
 * itself is a number nobody can change when a fleet turns out to be chattier
 * than this one.
 */

import type { RunEvent } from "@workspace/domain";
import { DateTime } from "effect";

/** Minutes are the unit the window is configured in; this is the conversion. */
const MS_PER_MINUTE = 60_000;

/**
 * The tools that change the workspace. A call to one of these is proof the run
 * is still producing something, which is why a single one anywhere in the
 * window is enough to answer "not stuck".
 *
 * Named per vendor rather than guessed at: these are what the Claude and Codex
 * providers report, and a tool this list does not know is treated as read-only,
 * which errs toward staying quiet.
 */
export const FILE_EDIT_TOOLS = [
  "Write",
  "Edit",
  "MultiEdit",
  "NotebookEdit",
  "apply_patch",
] as const;

const FILE_EDIT_TOOL_NAMES: ReadonlySet<string> = new Set(FILE_EDIT_TOOLS);

/**
 * The part of a run event this rule reads, taken off the domain type so a
 * changed payload is a compile error here rather than a heuristic that quietly
 * stops matching.
 */
export interface RunEventSample
  extends Pick<RunEvent, "occurredAt" | "payload"> {}

/** One tool call, flattened to the three things the rule reasons about. */
export interface ToolCall {
  /** The harness clock, in epoch milliseconds. */
  readonly at: number;
  readonly summary: string;
  readonly toolName: string;
}

/** The numbers the rule is held to, all of them configuration. */
export interface StuckThresholds {
  /** At or below this many distinct signatures, the run is repeating itself. */
  readonly distinctSignatures: number;
  /** Fewer calls than this in the window is a quiet run, not a stuck one. */
  readonly minToolCalls: number;
  /** How far back the rule looks, and how young a run is spared. */
  readonly windowMinutes: number;
}

/** Why a run that is not stuck is not stuck. Reported so a scan can say which test it passed. */
export const STUCK_MISS_REASONS = [
  "edited_files",
  "not_started",
  "too_few_tool_calls",
  "too_young",
  "varied_signatures",
] as const;

export type StuckMissReason = (typeof STUCK_MISS_REASONS)[number];

/**
 * The answer about one run. A union rather than a boolean and a bag of
 * optionals: the counts only exist on the stuck branch, and the reason only on
 * the other, so a caller cannot read one that was never measured.
 */
export type StuckVerdict =
  | {
      readonly kind: "stuck";
      /** The distinct `toolName summary` values it kept repeating. */
      readonly signatures: readonly string[];
      /** Since the last file edit, or since the run started when it never made one. */
      readonly stuckForMs: number;
      readonly toolCalls: number;
    }
  | { readonly kind: "working"; readonly reason: StuckMissReason };

/**
 * What makes two tool calls "the same call" for this rule: the tool and its
 * sanitized one-line summary. The summary is what the ingest already writes for
 * a reader, so `Bash ls packages` and `Bash ls apps` stay two calls while the
 * same listing repeated ten times stays one.
 */
export const toolSignature = (call: Pick<ToolCall, "summary" | "toolName">) =>
  `${call.toolName} ${call.summary}`;

/** Whether a call is one of the tools that writes to the workspace. */
export const editsFiles = (call: Pick<ToolCall, "toolName">) =>
  FILE_EDIT_TOOL_NAMES.has(call.toolName);

/** The tool calls in a run's events, in the order the harness reported them. */
export const toolCallsOf = (events: readonly RunEventSample[]) =>
  events.flatMap((event) =>
    event.payload.kind === "tool_call"
      ? [
          {
            at: DateTime.toEpochMillis(event.occurredAt),
            summary: event.payload.summary,
            toolName: event.payload.toolName,
          } satisfies ToolCall,
        ]
      : []
  );

/**
 * How long the run has looked stuck: since its last file edit, or since it
 * started when there is no edit among the events given.
 *
 * The floor is the run's start, so the number is never longer than the run.
 */
const stuckSinceMs = (options: {
  readonly calls: readonly ToolCall[];
  readonly nowMs: number;
  readonly startedAtMs: number;
}) => {
  const edits = options.calls.filter(editsFiles);
  const lastEdit = edits.at(-1);
  const since = Math.max(options.startedAtMs, lastEdit?.at ?? 0);
  return options.nowMs - since;
};

/**
 * Whether a live run has stopped getting anywhere.
 *
 * Three tests, in the order that answers cheapest first: a run younger than the
 * window has not had time to look stuck; a window with few tool calls in it is
 * a run thinking or waiting, not spinning; a window containing a file edit is a
 * run producing something. What is left — many calls, no edits, and at most a
 * couple of distinct signatures — is the shape of an agent going in circles.
 *
 * `now` and `startedAt` are arguments rather than clock reads, which is what
 * makes the whole rule a function of its inputs.
 */
export const stuckVerdict = (input: {
  readonly events: readonly RunEventSample[];
  readonly now: DateTime.Utc;
  readonly startedAt: DateTime.Utc | null;
  readonly thresholds: StuckThresholds;
}): StuckVerdict => {
  const { events, now, startedAt, thresholds } = input;
  if (startedAt === null) {
    return { kind: "working", reason: "not_started" };
  }

  const nowMs = DateTime.toEpochMillis(now);
  const startedAtMs = DateTime.toEpochMillis(startedAt);
  const windowMs = thresholds.windowMinutes * MS_PER_MINUTE;
  if (nowMs - startedAtMs < windowMs) {
    return { kind: "working", reason: "too_young" };
  }

  const calls = toolCallsOf(events);
  const inWindow = calls.filter((call) => call.at >= nowMs - windowMs);
  if (inWindow.length < Math.max(1, thresholds.minToolCalls)) {
    return { kind: "working", reason: "too_few_tool_calls" };
  }
  if (inWindow.some(editsFiles)) {
    return { kind: "working", reason: "edited_files" };
  }

  const signatures = [...new Set(inWindow.map(toolSignature))];
  if (signatures.length > thresholds.distinctSignatures) {
    return { kind: "working", reason: "varied_signatures" };
  }

  return {
    kind: "stuck",
    signatures,
    stuckForMs: stuckSinceMs({ calls, nowMs, startedAtMs }),
    toolCalls: inWindow.length,
  };
};
