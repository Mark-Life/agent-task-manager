/**
 * When two renders of a timeline row are the same row.
 *
 * A live run is polled, and every poll decodes its pages afresh: the same event
 * comes back as a new object with new fields inside it. A row memoized on object
 * identity therefore re-renders on every poll — hundreds of rows, several of
 * them parsing markdown and highlighting code, once every three seconds — and
 * that is what makes a long run worse to read live than dead.
 *
 * The comparison is on the fields a row draws rather than on the event's id,
 * which would also work and would be a bet on an invariant three layers away:
 * a row that compares what it renders cannot go stale, whatever the ingest
 * decides to do with a re-read of the same file. Kept out of the JSX so it is
 * unit-testable — a field a row renders and this module forgets would leave a
 * visibly stale row, which is the worse failure of the two.
 */
import type { RunEvent } from "@workspace/api";
import { RunEventPayload } from "@workspace/domain";
import { DateTime } from "effect";

/**
 * Whether two payloads would draw the same thing, in either reading.
 *
 * Exhaustive over the union the domain declares, so a new kind of event has to
 * say what makes it different here before it can be drawn — a kind missing from
 * this match would otherwise compare equal to itself forever and never update.
 * The fields listed are the union of what the table row and the chat node draw
 * between them; a field neither one shows is deliberately absent, because
 * re-rendering for a change nobody can see is the cost this module exists to
 * avoid.
 */
export const samePayload = (a: RunEventPayload, b: RunEventPayload): boolean =>
  RunEventPayload.match(a, {
    assistant_message: (said) =>
      b.kind === "assistant_message" &&
      said.text === b.text &&
      said.chars === b.chars &&
      said.truncated === b.truncated &&
      said.originalChars === b.originalChars,

    error: (problem) =>
      b.kind === "error" &&
      problem.errorClass === b.errorClass &&
      problem.errorMessage === b.errorMessage,

    failed: (crash) =>
      b.kind === "failed" &&
      crash.errorClass === b.errorClass &&
      crash.errorMessage === b.errorMessage &&
      crash.exitCode === b.exitCode,

    finished: (done) =>
      b.kind === "finished" &&
      done.outcome === b.outcome &&
      done.durationMs === b.durationMs &&
      done.totalTokens === b.totalTokens &&
      done.turns === b.turns &&
      done.costUsd === b.costUsd,

    log: (line) =>
      b.kind === "log" && line.level === b.level && line.message === b.message,

    reasoning: (thought) => b.kind === "reasoning" && thought.chars === b.chars,

    started: (start) =>
      b.kind === "started" &&
      start.provider === b.provider &&
      start.model === b.model &&
      start.sandboxImage === b.sandboxImage &&
      start.promptChars === b.promptChars,

    stopped: (kill) =>
      b.kind === "stopped" && kill.requestedByKind === b.requestedByKind,

    tool_call: (call) =>
      b.kind === "tool_call" &&
      call.callId === b.callId &&
      call.toolName === b.toolName &&
      call.summary === b.summary &&
      call.inputChars === b.inputChars,

    tool_result: (result) =>
      b.kind === "tool_result" &&
      result.callId === b.callId &&
      result.ok === b.ok &&
      result.summary === b.summary &&
      result.outputChars === b.outputChars,

    usage: (reading) =>
      b.kind === "usage" &&
      reading.inputTokens === b.inputTokens &&
      reading.outputTokens === b.outputTokens &&
      reading.turns === b.turns &&
      reading.costUsd === b.costUsd &&
      reading.rateLimitPct === b.rateLimitPct,
  });

/**
 * Two events that would render identically.
 *
 * The clock is compared as an instant rather than by object identity: it is
 * decoded into a fresh `DateTime` on every poll, and it is drawn on every table
 * row, so identity here would defeat the whole comparison.
 */
export const sameEvent = (a: RunEvent, b: RunEvent) =>
  DateTime.toEpochMillis(a.occurredAt) ===
    DateTime.toEpochMillis(b.occurredAt) && samePayload(a.payload, b.payload);

/** Two renders of a row that draws exactly one event. */
export const sameEventRow = (
  prev: { readonly event: RunEvent },
  next: { readonly event: RunEvent }
) => sameEvent(prev.event, next.event);

const bothNullOrSame = (a: RunEvent | null, b: RunEvent | null) =>
  a === null || b === null ? a === b : sameEvent(a, b);

/** The two halves a tool card draws; either may be missing. */
interface ToolPair {
  readonly call: RunEvent | null;
  readonly result: RunEvent | null;
}

/**
 * Two renders of the same call-and-result card.
 *
 * Both halves are compared, and a half arriving where there was none is a
 * change: a call whose result lands on the next poll must stop reading as
 * unanswered the moment it is answered.
 */
export const sameToolPair = (prev: ToolPair, next: ToolPair) =>
  bothNullOrSame(prev.call, next.call) &&
  bothNullOrSame(prev.result, next.result);

/** Two renders of a cluster: the same events, in the same order. */
export const sameEventCluster = (
  prev: { readonly events: readonly RunEvent[] },
  next: { readonly events: readonly RunEvent[] }
) =>
  prev.events.length === next.events.length &&
  prev.events.every((event, index) => {
    const other = next.events[index];
    return other !== undefined && sameEvent(event, other);
  });
