/**
 * A run, read one line per event.
 *
 * The forensic reading, and not a downgrade from the conversation: every event
 * keeps its own row in the order the container wrote it, a tool call stays
 * separate from the result that answered it, and nothing is smoothed over. This
 * is where somebody goes when the chat has folded away the thing they need to
 * see — a result that arrived four events later than its call, a burst of log
 * lines with one line in it that matters.
 */
import type { RunEvent } from "@workspace/api";
import { TimelineEvent } from "@/features/task/timeline-event";

export const RunTable = ({
  events,
}: {
  readonly events: readonly RunEvent[];
}) => (
  <ol className="flex flex-col gap-2" data-testid="run-table">
    {events.map((event) => (
      <TimelineEvent event={event} key={event.id} />
    ))}
  </ol>
);
