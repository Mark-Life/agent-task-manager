/**
 * The check that keeps `jsonb().$type<X>()` and every other unchecked cast
 * honest: a decoder's output must be *exactly* the domain entity, not merely
 * assignable to it.
 *
 * Assignability in one direction is not enough. A row that has grown a column
 * the entity never learned about still satisfies `Row extends Entity`, which is
 * the drift this file exists to catch — someone adds `text("owner")` to a table,
 * every repository keeps compiling, and the column is invisible to the domain
 * forever. So the comparison is identity, both ways round, and it is a compile
 * error rather than a runtime assertion because the schema is a compile-time
 * artefact.
 */

import type { Effect } from "effect";

/**
 * Whether two types are the same type, not merely mutually assignable. The
 * doubled conditional is the standard way to reach TypeScript's internal
 * identity relation, which is the only relation that distinguishes `string`
 * from `string & Brand<"TaskId">` in both directions at once.
 */
type Identical<A, B> =
  (<T>() => T extends A ? "same" : "other") extends <T>() => T extends B
    ? "same"
    : "other"
    ? true
    : false;

/** Fields the row carries that the entity has never heard of — a new column. */
type OnlyOnRow<Row, Entity> = Omit<Row, keyof Entity>;

/** Fields the entity expects that the row cannot supply — a dropped column. */
type OnlyOnEntity<Row, Entity> = Omit<Entity, keyof Row>;

/** Fields both sides carry under different types — a widened column, a lost brand. */
type Divergent<Row, Entity> = {
  readonly [K in Extract<keyof Row, keyof Entity> as Identical<
    Row[K],
    Entity[K]
  > extends true
    ? never
    : K]: { readonly entity: Entity[K]; readonly row: Row[K] };
};

/**
 * What `conforms` demands when the two shapes disagree. Naming the offending
 * keys is the point: a bare `false` tells you a table drifted but not which
 * column, and the compiler prints this type verbatim in the error.
 */
interface Drift<Row, Entity> {
  readonly divergent: Divergent<Row, Entity>;
  readonly onlyOnEntity: OnlyOnEntity<Row, Entity>;
  readonly onlyOnRow: OnlyOnRow<Row, Entity>;
}

/**
 * What a decoder hands back. Read off the function rather than off the schema
 * behind it, so a decoder that reshapes the row — rejoining a discriminator
 * column with its untagged blob — is held to the same contract as one that
 * simply decodes.
 */
export type Decoded<
  Decode extends (row: never) => Effect.Effect<unknown, unknown, never>,
> = Effect.Success<ReturnType<Decode>>;

/**
 * Asserts that a decoded row is exactly its domain entity. Call it from a test
 * with both type arguments named — `conforms<Decoded<typeof decodeTask>,
 * Task>(true)` — and adding, removing or retyping a column on either side stops
 * the package from typechecking.
 *
 * The witness is returned rather than discarded so the call is an expression a
 * test can assert on, which keeps it out of reach of anything that prunes
 * unused declarations.
 */
export const conforms = <Row, Entity>(
  witness: Identical<Row, Entity> extends true ? true : Drift<Row, Entity>
) => witness;

/**
 * Freezes the shape of a row a decoder had to reassemble. Spreading an object
 * produces mutable fields, and `conforms` compares types exactly — so without
 * this a decoder that rejoins a tag with its payload would fail the check for a
 * reason that has nothing to do with drift.
 */
export const asEntity = <T>(entity: T): Readonly<T> => entity;
