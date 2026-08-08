import { describe, expect, test } from "bun:test";
import type { ProviderUsageSnapshot } from "@workspace/api";
import type {
  ProviderUsageReport,
  ProviderUsageState,
  SessionProvider,
  UsageWindow,
} from "@workspace/domain";
import { DateTime } from "effect";
import { usageSummary, usageView } from "@/features/usage/model";

const now = DateTime.makeUnsafe("2026-08-07T12:00:00.000Z");

const minutesOn = (minutes: number) =>
  DateTime.makeUnsafe(DateTime.toEpochMillis(now) + minutes * 60_000);

const windowOf = (input: {
  readonly label: string;
  readonly remainingPercent: number;
  readonly resetsAt?: DateTime.Utc | null;
}): UsageWindow => ({
  kind: input.label.endsWith("d") ? "secondary" : "primary",
  label: input.label,
  remainingPercent: input.remainingPercent,
  resetsAt: input.resetsAt ?? null,
  usedPercent: 100 - input.remainingPercent,
  windowSeconds: null,
});

const reportOf = (input: {
  readonly enforced?: boolean;
  readonly note?: string | null;
  readonly pausedUntil?: DateTime.Utc | null;
  readonly provider: SessionProvider;
  readonly readAt?: DateTime.Utc | null;
  readonly state?: ProviderUsageState;
  readonly windows?: readonly UsageWindow[];
}): ProviderUsageReport => ({
  enforced: input.enforced ?? true,
  note: input.note ?? null,
  pausedUntil: input.pausedUntil ?? null,
  provider: input.provider,
  // An explicit null is "never read", which is not the same as leaving it out.
  readAt: "readAt" in input ? (input.readAt ?? null) : minutesOn(-3),
  state: input.state ?? "ok",
  windows: input.windows ?? [],
});

const snapshotOf = (
  providers: readonly ProviderUsageReport[]
): ProviderUsageSnapshot => ({ providers, publishedAt: minutesOn(-1) });

describe("usageView", () => {
  test("an empty provider list is nothing published, never a drained account", () => {
    const view = usageView({ providers: [], publishedAt: null }, now);

    expect(view.kind).toBe("blank");
    // The whole point of the variant: no path from here to a percentage.
    expect(JSON.stringify(view)).not.toContain("remainingPercent");
  });

  test("a provider that could not be read carries its reason, not a bar", () => {
    const view = usageView(
      snapshotOf([
        reportOf({
          note: "usage reads are switched off",
          provider: "codex",
          state: "unavailable",
        }),
      ]),
      now
    );

    expect(view).toMatchObject({
      kind: "published",
      providers: [
        {
          kind: "unreadable",
          name: "Codex",
          reason: "usage reads are switched off",
        },
      ],
    });
  });

  test("a reading with no windows is unreadable rather than empty", () => {
    const view = usageView(
      snapshotOf([reportOf({ provider: "claude", windows: [] })]),
      now
    );

    expect(view).toMatchObject({
      providers: [{ kind: "unreadable", reason: expect.any(String) }],
    });
  });

  test("windows keep the provider's own labels and gain a distance to the reset", () => {
    const view = usageView(
      snapshotOf([
        reportOf({
          provider: "claude",
          windows: [
            windowOf({
              label: "5h",
              remainingPercent: 62,
              resetsAt: minutesOn(42),
            }),
            windowOf({
              label: "7d",
              remainingPercent: 91,
              resetsAt: minutesOn(60 * 24 * 3),
            }),
          ],
        }),
      ]),
      now
    );

    expect(view).toMatchObject({
      providers: [
        {
          kind: "readable",
          readText: "read 3m ago",
          windows: [
            {
              label: "5h",
              remainingText: "62%",
              resetsInText: "in 42m",
              tone: "healthy",
            },
            { label: "7d", remainingText: "91%", resetsInText: "in 3d" },
          ],
        },
      ],
    });
  });

  test("a reset that has already passed is not rendered as a negative distance", () => {
    const view = usageView(
      snapshotOf([
        reportOf({
          provider: "claude",
          windows: [
            windowOf({
              label: "5h",
              remainingPercent: 4,
              resetsAt: minutesOn(-2),
            }),
          ],
        }),
      ]),
      now
    );

    expect(view).toMatchObject({
      providers: [{ windows: [{ resetsInText: "now", tone: "drained" }] }],
    });
  });

  test("a window with no reported reset says nothing rather than inventing one", () => {
    const view = usageView(
      snapshotOf([
        reportOf({
          provider: "codex",
          windows: [windowOf({ label: "7d", remainingPercent: 20 })],
        }),
      ]),
      now
    );

    expect(view).toMatchObject({
      providers: [{ windows: [{ resetsInText: null, tone: "low" }] }],
    });
  });

  test("the worst window is the one the rail draws, whichever it is", () => {
    const view = usageView(
      snapshotOf([
        reportOf({
          provider: "claude",
          windows: [
            windowOf({ label: "5h", remainingPercent: 80 }),
            windowOf({ label: "7d", remainingPercent: 12 }),
          ],
        }),
      ]),
      now
    );

    expect(view).toMatchObject({
      providers: [{ worst: { label: "7d", remainingText: "12%" } }],
    });
  });

  test("equally spent windows show the short one, which bites first", () => {
    const view = usageView(
      snapshotOf([
        reportOf({
          provider: "claude",
          windows: [
            windowOf({ label: "5h", remainingPercent: 30 }),
            windowOf({ label: "7d", remainingPercent: 30 }),
          ],
        }),
      ]),
      now
    );

    expect(view).toMatchObject({ providers: [{ worst: { label: "5h" } }] });
  });

  test("a pause, a reached limit and a watched-only reading each say so", () => {
    const windows = [windowOf({ label: "5h", remainingPercent: 3 })];
    const view = usageView(
      snapshotOf([
        reportOf({
          pausedUntil: minutesOn(12),
          provider: "claude",
          state: "paused",
          windows,
        }),
        reportOf({ provider: "codex", state: "limit_reached", windows }),
      ]),
      now
    );

    expect(view).toMatchObject({
      providers: [
        { statusText: "paused, back in 12m" },
        { statusText: "limit reached" },
      ],
    });
  });

  test("a reading nobody acts on says so, and a healthy enforced one stays quiet", () => {
    const windows = [windowOf({ label: "5h", remainingPercent: 70 })];
    const view = usageView(
      snapshotOf([
        reportOf({ enforced: false, provider: "claude", windows }),
        reportOf({ enforced: true, provider: "codex", windows }),
      ]),
      now
    );

    expect(view).toMatchObject({
      providers: [{ statusText: "not enforced" }, { statusText: null }],
    });
  });

  test("providers come back in a fixed order however the document listed them", () => {
    const windows = [windowOf({ label: "5h", remainingPercent: 50 })];
    const view = usageView(
      snapshotOf([
        reportOf({ provider: "codex", windows }),
        reportOf({ provider: "claude", windows }),
      ]),
      now
    );

    expect(view).toMatchObject({
      providers: [{ name: "Claude" }, { name: "Codex" }],
    });
  });

  test("a provider that has never been read has no age to show", () => {
    const view = usageView(
      snapshotOf([
        reportOf({
          provider: "claude",
          readAt: null,
          windows: [windowOf({ label: "5h", remainingPercent: 50 })],
        }),
      ]),
      now
    );

    expect(view).toMatchObject({
      providers: [{ kind: "readable", readText: null }],
    });
  });
});

describe("usageSummary", () => {
  test("stands in for the bars the collapsed rail draws without words", () => {
    const view = usageView(
      snapshotOf([
        reportOf({
          provider: "claude",
          windows: [
            windowOf({ label: "5h", remainingPercent: 62 }),
            windowOf({ label: "7d", remainingPercent: 91 }),
          ],
        }),
        reportOf({ provider: "codex", state: "unavailable" }),
      ]),
      now
    );

    expect(usageSummary(view)).toBe(
      "Provider usage: Claude 5h 62% left, 7d 91% left; Codex could not be read"
    );
  });

  test("says nothing has been read rather than naming a figure", () => {
    expect(
      usageSummary(usageView({ providers: [], publishedAt: null }, now))
    ).toContain("No reading yet");
  });
});
