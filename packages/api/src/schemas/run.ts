/**
 * A run and its event stream on the wire.
 *
 * The same rows serve three readers — the live timeline over SSE, the paged
 * replay, and whatever an external agent asks for — and they are one schema
 * because they are one table. Two shapes for one truth is how a dashboard and a
 * ledger start disagreeing about what a run did.
 */

import {
  Run as DomainRun,
  RunEvent as DomainRunEvent,
} from "@workspace/domain";
import { Schema } from "effect";

/** One attempt at a task, exactly as the store holds it. */
export const Run = DomainRun.annotate({ identifier: "Run" });

export interface Run extends Schema.Schema.Type<typeof Run> {}

/** One line of a run's normalized event stream. Append-only, and never rewritten. */
export const RunEvent = DomainRunEvent.annotate({ identifier: "RunEvent" });

export interface RunEvent extends Schema.Schema.Type<typeof RunEvent> {}

/**
 * A page of a run's timeline, oldest first.
 *
 * `nextSeq` is the cursor to ask for next, and `null` means the page reached
 * the end of what exists so far — which on a live run is not the same as the
 * end of the run. That is the point at which a reader switches to the stream.
 */
export const RunEventPage = Schema.Struct({
  events: Schema.Array(RunEvent),
  nextSeq: Schema.NullOr(Schema.Natural),
}).annotate({ identifier: "RunEventPage" });

export interface RunEventPage extends Schema.Schema.Type<typeof RunEventPage> {}

/**
 * How many events a page returns when the caller names no limit. Sized for one
 * screen of a timeline plus room to scroll, so the common case is one request.
 */
export const DEFAULT_EVENT_PAGE = 200;

/** How far into a run's timeline a request has already read. */
export const RunEventCursor = {
  /** Return only events after this ordinal. Absent starts at the beginning. */
  afterSeq: Schema.optionalKey(Schema.Natural),
} as const;
