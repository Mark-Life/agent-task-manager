import { traceparentOf } from "@workspace/domain";
import { Effect } from "effect";

/**
 * The span this write belongs to, as a W3C `traceparent`, or null outside one.
 *
 * Taken from the ambient span rather than from an argument, exactly as the
 * audit log takes its `trace_id`: a caller that has to remember to pass its
 * trace is a caller that will forget, and the write is already inside the
 * request's span by the time it reaches a repository. Null where there is no
 * span, which is a seed script or a test, and is a missing join rather than a
 * failure.
 *
 * The whole context and not just the id, because the far side does more than
 * join on it: the orchestrator opens its run *under* this span, so the run's
 * own spans and the container's turns become children of the request instead of
 * a second tree carrying a matching id.
 */
export const currentTraceparent = Effect.currentSpan.pipe(
  Effect.map((span) =>
    traceparentOf({
      sampled: span.sampled,
      spanId: span.spanId,
      traceId: span.traceId,
    })
  ),
  Effect.orElseSucceed(() => null)
);
