import { describe, expect, test } from "bun:test";
import { nextTheme } from "@/components/theme";

/**
 * A run of presses from a starting point, which is the only way to see the
 * property that matters: the screen flips every time, and control comes back to
 * the machine every second press.
 */
const press = (times: number, system: string) => {
  const stored: string[] = [];
  let resolved = system;
  for (const _ of Array.from({ length: times })) {
    const chosen = nextTheme({ resolved, system });
    stored.push(chosen);
    resolved = chosen === "system" ? system : chosen;
  }
  return stored;
};

describe("nextTheme", () => {
  test("first press overrides the machine", () => {
    expect(nextTheme({ resolved: "light", system: "light" })).toBe("dark");
    expect(nextTheme({ resolved: "dark", system: "dark" })).toBe("light");
  });

  test("second press hands control back rather than storing the other literal", () => {
    expect(nextTheme({ resolved: "dark", system: "light" })).toBe("system");
    expect(nextTheme({ resolved: "light", system: "dark" })).toBe("system");
  });

  test("presses alternate between an override and following the machine", () => {
    expect(press(4, "light")).toEqual(["dark", "system", "dark", "system"]);
    expect(press(4, "dark")).toEqual(["light", "system", "light", "system"]);
  });

  test("a machine that changed under an override still flips visibly", () => {
    // Stored `dark`, and the machine has since gone dark too. Handing control
    // back would leave the screen dark and the press would look ignored, so the
    // opposite is written as a literal instead.
    expect(nextTheme({ resolved: "dark", system: "dark" })).toBe("light");
  });
});
