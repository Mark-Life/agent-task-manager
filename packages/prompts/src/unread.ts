/**
 * What a session has not read yet, over any append-only conversation.
 *
 * A worker's comments on a task and a manager's messages in a thread are the
 * same question asked twice — "what has arrived since this session last
 * looked" — answered over the same `(createdAt, id)` tuple. One implementation
 * serves both, and the row type is only required to carry those two fields.
 *
 * A null watermark means "has seen nothing", which is how a fresh session gets
 * the conversation from the beginning with no special case: a new thread, a
 * provider switch or a lost session opens a session row whose watermark is
 * null, and the same code path answers it.
 */

import { DateTime } from "effect";

/**
 * How far a session has read: the last row it was shown.
 *
 * A tuple rather than a timestamp because two rows can share a millisecond.
 * Ids are uuidv7 and therefore time-ordered, so comparing them settles a
 * same-instant tie the same way the database's uuid comparison does.
 */
export interface Watermark {
  readonly createdAt: DateTime.Utc;
  readonly id: string;
}

/**
 * Strictly after the watermark, in the `(createdAt, id)` ordering the
 * conversation is read in.
 */
export const isAfterWatermark = (row: Watermark, watermark: Watermark) => {
  const rowMs = DateTime.toEpochMillis(row.createdAt);
  const watermarkMs = DateTime.toEpochMillis(watermark.createdAt);
  return rowMs === watermarkMs ? row.id > watermark.id : rowMs > watermarkMs;
};

/** A conversation as it came back from the database, and where the reader had got to. */
export interface UnreadInput<Row extends Watermark> {
  readonly rows: readonly Row[];
  readonly watermark: Watermark | null;
}

/**
 * The rows a session has genuinely not seen, out of what the repository
 * returned.
 *
 * A second filter over a query that already filtered, and it earns its place:
 * `created_at` is `timestamptz(6)` and the domain's `Timestamp` holds
 * milliseconds, so a watermark is a truncated copy of the row it names. The
 * database compares the truncation against the full-precision column, finds it
 * smaller, and hands back the very row the watermark was set to — every
 * resumed session would re-read the last thing it was shown, which for a run
 * whose own fallback comment sits at the end of the thread means reading its
 * own words back as new instructions forever. Comparing in the precision the
 * domain actually has is what closes that.
 */
export const unreadOf = <Row extends Watermark>({
  rows,
  watermark,
}: UnreadInput<Row>) =>
  watermark === null
    ? rows
    : rows.filter((row) => isAfterWatermark(row, watermark));

/**
 * The watermark after reading these rows: the last one rendered, or null when
 * there was nothing to read.
 *
 * The *last of the list*, not the newest by timestamp. The conversation is
 * ordered by `(createdAt, id)` and compared the same way, so two rows written
 * in the same millisecond are still strictly ordered — taking the maximum
 * timestamp instead would pick one of the pair arbitrarily and skip the other
 * forever.
 *
 * It is the last row *rendered* rather than the newest row on the table, so a
 * row that lands between the read and the write stays unread instead of being
 * skipped.
 */
export const nextWatermarkOf = <Row extends Watermark>(
  rows: readonly Row[]
): Pick<Row, "createdAt" | "id"> | null => {
  const last = rows.at(-1);
  return last === undefined ? null : { createdAt: last.createdAt, id: last.id };
};
