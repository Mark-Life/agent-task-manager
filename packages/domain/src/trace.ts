/**
 * The W3C `traceparent`, read and written in exactly one place.
 *
 * It sits in the domain rather than in `@workspace/telemetry` because both ends
 * of the seam need it and this is the only package below both: the database
 * stamps the header onto the row that asks for a run, and the orchestrator
 * parses it back off that row — a poll or a restart later — to adopt the span
 * that asked. A second copy of this format is a trace that joins on one side of
 * the boundary and not the other.
 *
 * Everything here is pure and total. A malformed header answers `null` rather
 * than failing: a trace that cannot be joined costs a join, and never the work
 * it was riding on.
 */

/** The trace context version this writes. `ff` is reserved as invalid. */
const VERSION = "00";
const INVALID_VERSION = "ff";

/** `version-traceId-spanId-flags`, each half a byte per hex digit. */
const TRACEPARENT = /^([\da-f]{2})-([\da-f]{32})-([\da-f]{16})-([\da-f]{2})$/;

/** An id of all zeros is the specification's way of spelling "no id". */
const ALL_ZEROS = /^0+$/;

/** The flags byte, sampled and not. */
const SAMPLED_FLAGS = "01";
const UNSAMPLED_FLAGS = "00";

const HEX = 16;

/** The sampled bit is the low one, so an odd flags byte means sampled. */
const isSampled = (flags: string) => Number.parseInt(flags, HEX) % 2 === 1;

/**
 * One span, identified. The same three fields Effect's `Tracer.externalSpan`
 * takes, which is what a parsed header is for.
 */
export interface TraceContext {
  readonly sampled: boolean;
  readonly spanId: string;
  readonly traceId: string;
}

/**
 * Reads a `traceparent` header, or answers `null` for anything that is not one
 * — absent, blank, the wrong shape, or carrying a zeroed id, which the
 * specification defines as no id at all.
 *
 * Exactly four fields are accepted. A future version may append more, and this
 * would then refuse a header it could have read the first four fields of; that
 * is the trade for never adopting a parent out of a string nobody validated.
 */
export const parseTraceparent = (
  header: string | null | undefined
): TraceContext | null => {
  if (header === null || header === undefined) {
    return null;
  }
  const match = TRACEPARENT.exec(header.trim());
  if (match === null) {
    return null;
  }
  const [, version = "", traceId = "", spanId = "", flags = ""] = match;
  if (
    version === INVALID_VERSION ||
    ALL_ZEROS.test(traceId) ||
    ALL_ZEROS.test(spanId)
  ) {
    return null;
  }
  return { sampled: isSampled(flags), spanId, traceId };
};

/** Writes a `traceparent` header for a span, the inverse of {@link parseTraceparent}. */
export const formatTraceparent = (context: TraceContext) =>
  `${VERSION}-${context.traceId}-${context.spanId}-${
    context.sampled ? SAMPLED_FLAGS : UNSAMPLED_FLAGS
  }`;

/**
 * {@link formatTraceparent} for ids that may be absent, which is what being
 * outside a trace looks like at every call site that has to ask.
 */
export const traceparentOf = (span: {
  /** Absent is sampled: a header written by a process that did not say means keep it. */
  readonly sampled?: boolean;
  readonly spanId: string | null;
  readonly traceId: string | null;
}) =>
  span.traceId === null || span.spanId === null
    ? null
    : formatTraceparent({
        sampled: span.sampled ?? true,
        spanId: span.spanId,
        traceId: span.traceId,
      });
