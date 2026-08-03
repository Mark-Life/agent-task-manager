import { describe, expect, test } from "bun:test";
import { CostUsd } from "@workspace/domain";
import { DateTime } from "effect";
import {
  formatAbsolute,
  formatCost,
  formatDuration,
  formatRelative,
  formatTokens,
} from "@/lib/format";

const at = (iso: string) => DateTime.makeUnsafe(iso);
const now = at("2026-08-02T12:00:00Z");

/** A zone and locale the assertions can rely on, whatever the machine's are. */
const pinned = { locale: "en-GB", timeZone: "UTC" } as const;

describe("formatAbsolute", () => {
  test("renders the instant in the requested zone", () => {
    const text = formatAbsolute(at("2026-08-02T10:30:00Z"), pinned);
    expect(text).toContain("2026");
    expect(text).toContain("10:30");
  });

  test("drops the time when asked for a date alone", () => {
    const text = formatAbsolute(at("2026-08-02T10:30:00Z"), {
      ...pinned,
      timeStyle: undefined,
    });
    expect(text).not.toContain("10:30");
  });
});

describe("formatRelative", () => {
  test("collapses the last few seconds", () => {
    expect(formatRelative(at("2026-08-02T11:59:40Z"), now)).toBe("just now");
  });

  test("counts minutes, hours and days", () => {
    expect(formatRelative(at("2026-08-02T11:57:00Z"), now)).toBe("3m ago");
    expect(formatRelative(at("2026-08-02T09:00:00Z"), now)).toBe("3h ago");
    expect(formatRelative(at("2026-07-31T12:00:00Z"), now)).toBe("2d ago");
  });

  test("reads forwards for a future instant", () => {
    expect(formatRelative(at("2026-08-02T12:05:00Z"), now)).toBe("in 5m");
  });

  test("falls back to a date past a week", () => {
    expect(formatRelative(at("2026-06-01T12:00:00Z"), now)).toContain("2026");
  });
});

describe("formatDuration", () => {
  test("renders nothing for a run that reported none", () => {
    expect(formatDuration(null)).toBeNull();
    expect(formatDuration(undefined)).toBeNull();
  });

  test("loses precision as the magnitude grows", () => {
    expect(formatDuration(0)).toBe("0ms");
    expect(formatDuration(820)).toBe("820ms");
    expect(formatDuration(1500)).toBe("1.5s");
    expect(formatDuration(125_000)).toBe("2m 5s");
    expect(formatDuration(7_500_000)).toBe("2h 5m");
  });
});

describe("formatTokens", () => {
  test("renders nothing for an unreported count", () => {
    expect(formatTokens(null)).toBeNull();
  });

  test("abbreviates above a thousand and drops a bare .0", () => {
    expect(formatTokens(0)).toBe("0");
    expect(formatTokens(940)).toBe("940");
    expect(formatTokens(41_250)).toBe("41.3k");
    expect(formatTokens(42_000)).toBe("42k");
    expect(formatTokens(2_400_000)).toBe("2.4M");
  });
});

describe("formatCost", () => {
  test("renders nothing when there is no cost, never a zero", () => {
    expect(formatCost(null)).toBeNull();
    expect(formatCost(undefined)).toBeNull();
  });

  test("keeps a genuine zero distinct from a missing one", () => {
    expect(formatCost(CostUsd.make("0"))).toBe("$0.00");
  });

  test("bounds a cost too small for two decimals", () => {
    expect(formatCost(CostUsd.make("0.004"))).toBe("<$0.01");
  });

  test("renders dollars with cents", () => {
    expect(formatCost(CostUsd.make("1.2345"))).toBe("$1.23");
    expect(formatCost(CostUsd.make("12.5"))).toBe("$12.50");
  });
});
