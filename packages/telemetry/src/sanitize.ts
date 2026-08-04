import { createHash } from "node:crypto";
import { Schema, SchemaGetter } from "effect";

/** Maximum characters kept on any free-text field of a wide event. */
export const MAX_FIELD_CHARS = 240;

/** Characters of the content hash kept on an event — enough to correlate, too few to reverse. */
const HASH_CHARS = 16;

/** Secret shapes stripped from any free text before it reaches a durable sink. */
const SECRET_PATTERNS: readonly RegExp[] = [
  /Bearer\s+[\w.-]+/gi,
  /\bsk-[A-Za-z0-9_-]{8,}/g,
  /\bxox[abprs]-[A-Za-z0-9-]+/g,
  /\b\d{6,}:[A-Za-z0-9_-]{20,}/g,
];

/**
 * Sanitizes free text for durable storage: collapses all whitespace to single
 * spaces, redacts common secret shapes (Bearer / sk- / xox- / bot token), then
 * caps the result at {@link MAX_FIELD_CHARS}. Pure; never returns a secret
 * substring it recognized.
 */
export const clipError = (message: string) => {
  const collapsed = message.replace(/\s+/g, " ").trim();
  const redacted = SECRET_PATTERNS.reduce(
    (accumulated, pattern) => accumulated.replace(pattern, "[redacted]"),
    collapsed
  );
  return redacted.length > MAX_FIELD_CHARS
    ? redacted.slice(0, MAX_FIELD_CHARS)
    : redacted;
};

/**
 * A string field that is sanitized by the schema itself, on both decode and
 * encode, so a field added later cannot skip {@link clipError}.
 */
export const SanitizedText = Schema.decode<typeof Schema.String>({
  decode: SchemaGetter.transform(clipError),
  encode: SchemaGetter.transform(clipError),
})(Schema.String);

/**
 * Measures content instead of carrying it: the character count plus a short
 * hash, so two runs that saw the same prompt are joinable without the prompt
 * ever reaching an event.
 */
export const measureText = (text: string) => ({
  chars: text.length,
  hash: createHash("sha256").update(text).digest("hex").slice(0, HASH_CHARS),
});
