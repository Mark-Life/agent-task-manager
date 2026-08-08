import { describe, expect, test } from "bun:test";
import { destinationFor } from "@/components/shell";

/**
 * The letters the sidebar has spoken for. Not read off `DESTINATIONS` — a test
 * that derives its expectations from the thing it is testing agrees with any
 * change, including the one that swaps two rows' letters and sends `p` to the
 * keys. These are written out so that moving a letter has to be done twice, on
 * purpose.
 */
const BOUND = [
  { key: "b", to: "/" },
  { key: "p", to: "/projects" },
  { key: "k", to: "/api-keys" },
] as const;

/**
 * Letters bound elsewhere in the app, plus one nobody has taken. None of them
 * may resolve here: a collision would mean two things happen on one keystroke,
 * and the shell's answer would be the silent one — a navigation away from the
 * screen the other shortcut was meant to act on.
 */
const NOT_OURS = ["d", "f", "n", "1", "9", "z"];

describe("destinationFor", () => {
  for (const { key, to } of BOUND) {
    test(`${key} leads to ${to}`, () => {
      expect(destinationFor(key)?.to).toBe(to);
    });
  }

  test("every destination carries a letter and no two share one", () => {
    const keys = BOUND.map((entry) => entry.key);

    expect(new Set(keys).size).toBe(keys.length);
    for (const key of keys) {
      expect(destinationFor(key)).not.toBeNull();
    }
  });

  test("a letter this list has not taken leads nowhere", () => {
    for (const key of NOT_OURS) {
      expect(destinationFor(key)).toBeNull();
    }
  });

  test("the shift of a bound letter is not the bound letter", () => {
    // The hook compares `key` exactly, so a capital arrives as its own string
    // and must not be read as the letter underneath it: `Shift`+`P` in a
    // sentence is not a request to leave the page.
    expect(destinationFor("B")).toBeNull();
    expect(destinationFor("P")).toBeNull();
    expect(destinationFor("K")).toBeNull();
  });
});
