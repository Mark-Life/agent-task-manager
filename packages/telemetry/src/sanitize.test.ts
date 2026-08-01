import { describe, expect, test } from "bun:test";
import { Schema } from "effect";
import {
  clipError,
  MAX_FIELD_CHARS,
  measureText,
  SanitizedText,
} from "./sanitize";

describe("clipError", () => {
  test("collapses whitespace to single spaces and trims", () => {
    expect(clipError("  a\n\n b\t c  ")).toBe("a b c");
  });

  test("redacts common secret shapes, never returns the secret", () => {
    const redacted = clipError(
      "auth Bearer abc.def-123 key sk-abcd1234EFGH slack xoxb-123-abcDEF tok 123456:AAaaBBbbCCccDDddEEeeFFff00"
    );
    expect(redacted).toContain("[redacted]");
    expect(redacted).not.toContain("abc.def-123");
    expect(redacted).not.toContain("sk-abcd1234EFGH");
    expect(redacted).not.toContain("xoxb-123-abcDEF");
    expect(redacted).not.toContain("123456:AAaaBBbb");
  });

  test("caps at MAX_FIELD_CHARS", () => {
    expect(clipError("x".repeat(1000)).length).toBe(MAX_FIELD_CHARS);
  });
});

describe("SanitizedText", () => {
  test("sanitizes on encode, so a field cannot skip the sanitizer", () => {
    const encode = Schema.encodeSync(SanitizedText);
    expect(encode("token  Bearer abc-123\nnext")).toBe("token [redacted] next");
  });

  test("sanitizes on decode as well", () => {
    const decode = Schema.decodeUnknownSync(SanitizedText);
    expect(decode("  a\n b  ")).toBe("a b");
  });
});

describe("measureText", () => {
  test("returns a count and a short stable hash, never the text", () => {
    const measured = measureText("hello world");
    expect(measured.chars).toBe(11);
    expect(measured.hash).toBe(measureText("hello world").hash);
    expect(measured.hash).not.toContain("hello");
    expect(measured.hash.length).toBe(16);
  });
});
