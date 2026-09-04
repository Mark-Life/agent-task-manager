import type { RunEvent } from "@workspace/api";
import { type RunEventKind, RunEventPayload } from "@workspace/domain";
import { memo } from "react";
import { Facts } from "@/features/task/chat-parts";
import { sameEventRow } from "@/features/task/run-row";
import {
  formatAbsolute,
  formatCost,
  formatDuration,
  formatTokens,
} from "@/lib/format";

/**
 * What each kind of event is called on screen. The stored tags are written for
 * a switch statement; a reader wants the verb, and one table keeps the two from
 * being spelled differently in different places.
 */
const KIND_LABELS = {
  assistant_message: "said",
  error: "error",
  failed: "failed",
  finished: "finished",
  log: "log",
  reasoning: "thought",
  started: "started",
  stopped: "stopped",
  tool_call: "tool",
  tool_result: "result",
  usage: "usage",
} as const satisfies Record<RunEventKind, string>;

/** The kinds that are about something going wrong, and are coloured as such. */
const ALARMING: readonly RunEventKind[] = ["error", "failed"];

/** Just the wall-clock time: a timeline already says what day it is. */
const timeOf = (event: RunEvent) =>
  formatAbsolute(event.occurredAt, {
    dateStyle: undefined,
    timeStyle: "medium",
  });

/**
 * One line of a run's normalized event stream.
 *
 * The eleven kinds read very differently — a tool call is a name and a
 * one-line summary, a usage reading is four numbers, an assistant message is
 * prose — so each gets its own body rather than a shared key-value dump that
 * would flatten all of them into the same shape. Text arrives already clipped
 * by the ingest, and the clip is shown rather than hidden.
 */
const TimelineEventBody = ({ event }: { readonly event: RunEvent }) => (
  <li className="flex gap-3 text-xs [contain-intrinsic-size:auto_1.5rem] [content-visibility:auto]">
    <span className="w-20 shrink-0 pt-px text-muted-foreground tabular-nums">
      {timeOf(event)}
    </span>
    <span
      className={
        ALARMING.includes(event.payload.kind)
          ? "w-16 shrink-0 pt-px text-destructive"
          : "w-16 shrink-0 pt-px text-muted-foreground"
      }
    >
      {KIND_LABELS[event.payload.kind]}
    </span>
    <div className="min-w-0 flex-1">
      <EventBody payload={event.payload} />
    </div>
  </li>
);

/**
 * One row, redrawn only when what it draws changes.
 *
 * A live run is polled and every poll decodes its pages afresh, so without this
 * every row in a two-thousand-event timeline re-renders every three seconds.
 * See `run-row.ts` for what counts as the same row.
 */
export const TimelineEvent = memo(TimelineEventBody, sameEventRow);

/**
 * The part of an event that differs by kind. Exhaustive over the union the
 * domain declares, so a new kind of event is a compile error here rather than a
 * blank line in a timeline somebody is reading to find out what happened.
 */
const EventBody = ({ payload }: { readonly payload: RunEventPayload }) =>
  RunEventPayload.match(payload, {
    assistant_message: (said) => (
      <div className="flex flex-col gap-0.5">
        <p className="whitespace-pre-wrap">{said.text}</p>
        {said.truncated === true ? (
          <span className="text-muted-foreground">
            clipped from {said.originalChars ?? said.chars} chars
          </span>
        ) : null}
      </div>
    ),

    error: (problem) => (
      <p className="whitespace-pre-wrap text-destructive">
        {problem.errorClass}: {problem.errorMessage}
      </p>
    ),

    failed: (crash) => (
      <p className="whitespace-pre-wrap text-destructive">
        {crash.errorClass}: {crash.errorMessage}
        {crash.exitCode === null ? null : ` (exit ${crash.exitCode})`}
      </p>
    ),

    finished: (done) => (
      <FactRow
        items={[
          done.outcome,
          formatDuration(done.durationMs),
          `${formatTokens(done.totalTokens)} tokens`,
          `${done.turns} turns`,
          formatCost(done.costUsd),
        ]}
      />
    ),

    log: (line) => (
      <p
        className={
          line.level === "error"
            ? "whitespace-pre-wrap text-destructive"
            : "whitespace-pre-wrap text-muted-foreground"
        }
      >
        {line.message}
      </p>
    ),

    reasoning: (thought) => (
      <FactRow items={[`${thought.chars} chars of reasoning`]} />
    ),

    started: (start) => (
      <FactRow
        items={[
          start.provider,
          start.model,
          start.sandboxImage,
          `${start.promptChars} chars of prompt`,
        ]}
      />
    ),

    stopped: (kill) => (
      <FactRow items={[`asked for by the ${kill.requestedByKind}`]} />
    ),

    tool_call: (call) => (
      <div className="flex flex-wrap items-baseline gap-2">
        <span className="font-medium">{call.toolName}</span>
        <span className="text-muted-foreground">{call.summary}</span>
      </div>
    ),

    tool_result: (result) => (
      <div className="flex flex-wrap items-baseline gap-2">
        <span
          className={result.ok ? "text-muted-foreground" : "text-destructive"}
        >
          {result.ok ? "ok" : "failed"}
        </span>
        <span className="text-muted-foreground">{result.summary}</span>
      </div>
    ),

    usage: (reading) => (
      <FactRow
        items={[
          `${formatTokens(reading.inputTokens)} in`,
          `${formatTokens(reading.outputTokens)} out`,
          `${reading.turns} turns`,
          formatCost(reading.costUsd),
          reading.rateLimitPct === null
            ? null
            : `${Math.round(reading.rateLimitPct)}% of the rate limit`,
        ]}
      />
    ),
  });

/**
 * A row of small facts, shared with the conversation reading so the same event
 * is worded the same way in both. The frame is the table's own: one line of
 * muted text, which is what a dense reading of eleven kinds needs it to be.
 */
const FactRow = ({ items }: { readonly items: readonly (string | null)[] }) => (
  <div className="flex flex-wrap items-baseline gap-2 text-muted-foreground">
    <Facts items={items} />
  </div>
);
