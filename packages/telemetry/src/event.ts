import { Schema } from "effect";
import { SanitizedText } from "./sanitize";

/**
 * Outcomes shared by every unit of work. A unit extends the tuple with its own
 * literals — `Schema.Literals([...BASE_OUTCOMES, "parked", "lost"])` — so a
 * group-by over `outcome` stays exhaustive by construction.
 */
export const BASE_OUTCOMES = [
  "done",
  "errored",
  "interrupted",
  "timeout",
] as const;

/** The shared outcome union. Units widen it; nothing narrows it. */
export const BaseOutcome = Schema.Literals(BASE_OUTCOMES);

/**
 * The `outcome` field for a unit of work, widened with the unit's own literals.
 *
 * Nullable by construction: a `start` row is written before anything has
 * happened, so it has no outcome, and a placeholder there would be counted as a
 * real ending. Pass `[]` for a unit that needs no extra literals.
 */
export const outcomeField = <const Extra extends readonly string[]>(
  extra: Extra
) => Schema.NullOr(Schema.Literals([...BASE_OUTCOMES, ...extra]));

/**
 * `start` marks the row written when a long unit claims its work; `end` marks
 * the terminus. A `start` with no matching `end` is a lost unit, which is the
 * whole point of writing both.
 */
export const EVENT_PHASES = ["start", "end"] as const;

/** Phase of a unit of work. */
export const EventPhase = Schema.Literals(EVENT_PHASES);

const NullableString = Schema.NullOr(Schema.String);
const NullableNumber = Schema.NullOr(Schema.Number);

/**
 * High-cardinality ids that join one unit of work to every other. Null where the
 * unit genuinely does not know the id — never a placeholder.
 */
export const identityFields = {
  runId: NullableString,
  sessionId: NullableString,
  spanId: NullableString,
  taskId: NullableString,
  traceId: NullableString,
  workspaceId: NullableString,
};

/**
 * What the unit of work cost. Every field is nullable because a degraded
 * outcome did not cost 0 and did not take 0ms — it produced no number at all,
 * and a fabricated 0 is a number someone will later average.
 */
export const economicsFields = {
  costUsd: NullableNumber,
  durationMs: NullableNumber,
  queueWaitMs: NullableNumber,
  totalTokens: NullableNumber,
  turns: NullableNumber,
};

/** How the unit ended, plus the classification behind a non-success ending. */
export const outcomeFields = {
  errorClass: Schema.NullOr(SanitizedText),
  errorMessage: Schema.NullOr(SanitizedText),
  outcome: outcomeField([]),
};

/** Stamped once at startup by the emitter, identical on every row of a process. */
export const environmentFields = {
  gitSha: Schema.String,
  host: Schema.String,
  version: Schema.String,
};

/** The environment stamp carried by every event. */
export const Environment = Schema.Struct(environmentFields);

export interface Environment extends Schema.Schema.Type<typeof Environment> {}

/**
 * The fields every unit of work supplies. `event`, `ts` and the environment are
 * stamped by the emitter, so they are deliberately absent here.
 */
export const wideEventFields = {
  phase: EventPhase,
  ...identityFields,
  ...economicsFields,
  ...outcomeFields,
};

/** The shared vocabulary on its own, for reference and for tests. */
export const WideEventBase = Schema.Struct(wideEventFields);

export interface WideEventBase
  extends Schema.Schema.Type<typeof WideEventBase> {}

/**
 * Field names that would carry content rather than a measurement of it.
 * `defineEvent` rejects them, so a prompt or a transcript cannot reach a row.
 */
type ContentKey =
  | "argv"
  | "body"
  | "command"
  | "content"
  | "diff"
  | "message"
  | "output"
  | "patch"
  | "prompt"
  | "stderr"
  | "stdout"
  | "text"
  | "transcript";

/**
 * Field names the emitter owns. `ts` is the ledger's ordering key and `event` is
 * the filter key every query starts from, so a unit may not supply either.
 */
type ReservedKey = "event" | "ts";

/**
 * A field of a wide event: a schema that needs no services to encode, so a row
 * can be written from anywhere without dragging a context along.
 */
type EventField = Schema.Constraint & {
  readonly DecodingServices: never;
  readonly EncodingServices: never;
};

/**
 * Struct fields with the content-carrying and emitter-owned names ruled out at
 * compile time.
 */
export type ContentFreeFields = Readonly<Record<string, EventField>> & {
  readonly [K in ContentKey | ReservedKey]?: never;
};

/** A JSON scalar. Events stay flat so every field is directly queryable. */
export type EventValue = boolean | number | string | null;

/** One encoded wide event, ready for the sinks. */
export type EventFields = Readonly<Record<string, EventValue>>;

/**
 * Ties `phase` to `outcome`: a `start` row is claimed work and has not ended, so
 * it carries no outcome; an `end` row is a terminus and must name one. Without
 * this a start row has to invent an ending, and every count over `outcome`
 * doubles.
 */
const phaseAgreesWithOutcome = Schema.makeFilter((row: unknown) => {
  if (typeof row !== "object" || row === null) {
    return;
  }
  const outcome = Reflect.get(row, "outcome");
  if (Reflect.get(row, "phase") === "start") {
    return outcome === null
      ? undefined
      : "a start row carries no outcome: it has not ended";
  }
  return outcome === null ? "an end row must name its outcome" : undefined;
});

/**
 * Defines the wide event for one unit of work: the shared vocabulary plus the
 * unit's own fields, under its marker. Returns the marker, the schema of what
 * the unit supplies, a synchronous encoder for the emit path, and the schema of
 * the row as it is actually stored.
 */
export const defineEvent = <
  const Marker extends string,
  Fields extends ContentFreeFields,
>(
  marker: Marker,
  fields: Fields
) => {
  const schema = Schema.Struct({ ...wideEventFields, ...fields }).pipe(
    Schema.check(phaseAgreesWithOutcome)
  );
  const rowSchema = Schema.Struct({
    event: Schema.tag(marker),
    ts: Schema.String,
    ...environmentFields,
    ...wideEventFields,
    ...fields,
  });
  return {
    encode: Schema.encodeSync(schema),
    marker,
    rowSchema,
    schema,
  } as const;
};

/** A unit's event definition, as produced by {@link defineEvent}. */
export interface EventDefinition<Input> {
  readonly encode: (input: Input) => EventFields;
  readonly marker: string;
}
