import { Schema } from "effect";

/**
 * A `jsonb` column that always holds an object. Narrower than the derived
 * column schema, which accepts any JSON value at all, and the narrowing is what
 * lets a decoder spread the blob without asking whether it is really a number.
 */
export const JsonObject = Schema.Record(Schema.String, Schema.Json);

/**
 * Puts a discriminator column back on the blob it was taken off, which is the
 * inverse of the domain's `splitPayload`. A tagged payload is stored as a `kind`
 * column plus a blob that never repeats the tag — one copy, so the two cannot
 * disagree — and the union can only be decoded once they are rejoined.
 *
 * The result is deliberately `unknown` to the caller: it is untrusted storage
 * until the union schema has passed it, and typing it any other way would make
 * the decode that follows look optional.
 */
export const joinPayload = (
  kind: string,
  payload: typeof JsonObject.Type
): unknown => ({ ...payload, kind });
