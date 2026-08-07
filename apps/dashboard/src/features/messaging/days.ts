import type { DateTime } from "effect";
import { formatAbsolute } from "@/lib/format";

/** Anything a conversation is made of: the time is all this file needs. */
interface Timed {
  readonly createdAt: DateTime.Utc;
}

/** The day something belongs to, in the reader's own zone. */
const dayOf = (item: Timed) =>
  formatAbsolute(item.createdAt, { timeStyle: undefined });

/** One row of a conversation, and the day divider that opens it if it opens one. */
export interface DayMarked<T> {
  readonly day: string | null;
  readonly item: T;
}

/**
 * A conversation, split into days.
 *
 * A divider belongs to the message that opens a day rather than to a list of
 * its own, so the rows stay one flat array and the scroller keeps one item per
 * message — which is what its anchoring counts.
 */
export const withDayMarkers = <T extends Timed>(
  items: readonly T[]
): readonly DayMarked<T>[] =>
  items.map((item, index) => {
    const previous = items[index - 1];
    const day = dayOf(item);
    if (previous === undefined || dayOf(previous) !== day) {
      return { day, item };
    }
    return { day: null, item };
  });
