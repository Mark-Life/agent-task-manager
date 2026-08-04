import { Schema } from "effect";
import { WorkspaceId } from "./ids";

/**
 * Every instant we store is a `timestamptz` read as a `Date`, and every instant
 * the domain reasons about is a `DateTime.Utc`. Going through the zone-aware
 * type is what stops "how long has this task been in this column" from picking
 * up whatever timezone the process happens to run in.
 */
export const Timestamp = Schema.DateTimeUtcFromDate;
export type Timestamp = typeof Timestamp.Type;

/**
 * A cost in US dollars, carried as the exact decimal string the numeric column
 * holds. Money that has been through a float no longer adds up, so the value
 * stays textual and is parsed only where something formats or charts it.
 */
export const CostUsd = Schema.String.pipe(
  Schema.check(Schema.isPattern(/^-?\d+(\.\d+)?$/)),
  Schema.brand("CostUsd")
);
export type CostUsd = typeof CostUsd.Type;

/** The one place a {@link CostUsd} becomes a float: display and metrics, never storage. */
export const costUsdToNumber = (cost: CostUsd) => Number(cost);

/**
 * Splits a payload that carries its own discriminator into the column a row
 * stores the discriminator in and the blob that never repeats it. One
 * implementation, so a writer and a reader cannot disagree about whether the
 * tag is inside the JSON.
 */
export const splitPayload = <K extends string, P extends { readonly kind: K }>(
  tagged: P
) => {
  const { kind, ...payload } = tagged;
  return { kind, payload };
};

/**
 * The columns of an append-only table. `run_event` and `audit_entry` are
 * written once and never rewritten — the first migration revokes UPDATE on
 * them — so an update stamp there could only ever lie.
 */
export const appendOnlyFields = {
  createdAt: Timestamp,
  workspaceId: WorkspaceId,
};

/**
 * The columns every other table of ours carries. Spelled once, so a new
 * aggregate cannot ship without the `workspaceId` that scopes every query.
 * `updatedAt` is maintained by a BEFORE UPDATE trigger, not by writers.
 */
export const recordFields = {
  ...appendOnlyFields,
  updatedAt: Timestamp,
};
