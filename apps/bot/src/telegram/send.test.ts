import { describe, expect, test } from "bun:test";
import { DEFAULT_SPLIT_AT, splitText } from "./send";

const repeat = (text: string, times: number) => text.repeat(times);

describe("splitText", () => {
  test("leaves short text alone", () => {
    expect(splitText({ text: "hello" })).toEqual(["hello"]);
  });

  test("leaves text exactly at the limit alone", () => {
    const text = repeat("a", DEFAULT_SPLIT_AT);
    expect(splitText({ text })).toEqual([text]);
  });

  test("splits at the last newline past halfway", () => {
    const text = `${repeat("a", 7)}\n${repeat("b", 7)}`;
    expect(splitText({ maxLength: 10, text })).toEqual([
      repeat("a", 7),
      `\n${repeat("b", 7)}`,
    ]);
  });

  test("hard-cuts when the only newline is too early", () => {
    const text = `a\n${repeat("b", 20)}`;
    expect(splitText({ maxLength: 10, text })[0]).toBe(text.slice(0, 10));
  });

  test("hard-cuts when there is no newline at all", () => {
    expect(splitText({ maxLength: 10, text: repeat("a", 25) })).toEqual([
      repeat("a", 10),
      repeat("a", 10),
      repeat("a", 5),
    ]);
  });

  test("is lossless — the chunks rebuild the input", () => {
    const text = Array.from({ length: 400 }, (_, i) => `line ${i}`).join("\n");
    expect(splitText({ maxLength: 200, text }).join("")).toBe(text);
  });

  test("every chunk fits the budget", () => {
    const text = Array.from({ length: 400 }, (_, i) => `line ${i}`).join("\n");
    for (const chunk of splitText({ maxLength: 200, text })) {
      expect(chunk.length).toBeLessThanOrEqual(200);
    }
  });

  test("terminates on a pathological budget", () => {
    expect(splitText({ maxLength: 0, text: "abc" })).toEqual(["a", "b", "c"]);
  });
});
