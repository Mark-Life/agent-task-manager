import { Metric } from "effect";

/**
 * Maps an absent tag value to the `"none"` sentinel, so a metric's series count
 * stays fixed instead of growing an untagged twin.
 */
export const orNone = (value: string | null | undefined) => {
  const trimmed = value?.trim() ?? "";
  return trimmed.length > 0 ? trimmed : "none";
};

/** The allowed values of one tag, written down as a `const` tuple. */
type TagValues = readonly [string, ...string[]];

/**
 * Tag names whose value space cannot be enumerated. They belong on the event,
 * never on a metric, so a helper rejects them at compile time.
 */
type UnboundedTagKey =
  | "path"
  | "repo"
  | "runId"
  | "sessionId"
  | "spanId"
  | "taskId"
  | "traceId"
  | "url"
  | "userId"
  | "workspaceId";

/** A metric's tag vocabulary: every tag drawn from an enumerated tuple. */
export type TagSpec = Readonly<Record<string, TagValues>> & {
  readonly [K in UnboundedTagKey]?: never;
};

/** What a call site supplies: one listed value per tag, or nothing. */
export type TagInput<Spec extends TagSpec> = {
  readonly [K in keyof Spec]: Spec[K][number] | null | undefined;
};

const attributesOf = (
  keys: readonly string[],
  values: Readonly<Record<string, string | null | undefined>>
) => Object.fromEntries(keys.map((key) => [key, orNone(values[key])]));

/** Shared shape of a bounded metric declaration. */
interface BoundedOptions<Spec extends TagSpec> {
  readonly description?: string;
  readonly tags: Spec;
}

/**
 * A counter whose attribute keys are fixed at declaration and whose values come
 * from `const` tuples, so an unlisted value is a type error rather than a new
 * time series. Derive it from a wide event at the emit site.
 */
export const boundedCounter = <const Spec extends TagSpec>(
  name: string,
  options: BoundedOptions<Spec>
) => {
  const counter = Metric.counter(name, { description: options.description });
  const tagKeys = Object.keys(options.tags).sort();
  return {
    /** Adds `amount` (default 1) to the series named by `tags`. */
    increment: (tags: TagInput<Spec>, amount = 1) =>
      Metric.update(
        Metric.withAttributes(counter, attributesOf(tagKeys, tags)),
        amount
      ),
    name,
    tagKeys,
  } as const;
};

/** A histogram declaration adds its bucket boundaries. */
interface BoundedHistogramOptions<Spec extends TagSpec>
  extends BoundedOptions<Spec> {
  readonly boundaries: readonly number[];
}

/**
 * A histogram under the same tag discipline as {@link boundedCounter}: fixed
 * attribute keys, enumerated values, absent values as `"none"`.
 */
export const boundedHistogram = <const Spec extends TagSpec>(
  name: string,
  options: BoundedHistogramOptions<Spec>
) => {
  const histogram = Metric.histogram(name, {
    boundaries: options.boundaries,
    description: options.description,
  });
  const tagKeys = Object.keys(options.tags).sort();
  return {
    name,
    /** Records one observation on the series named by `tags`. */
    record: (tags: TagInput<Spec>, value: number) =>
      Metric.update(
        Metric.withAttributes(histogram, attributesOf(tagKeys, tags)),
        value
      ),
    tagKeys,
  } as const;
};
