import { describe, expect, it } from "bun:test";
import { DateTime } from "effect";
import {
  buildLabel,
  renderSystemDown,
  renderSystemUp,
  shutdownVerdict,
  startupVerdict,
  systemDedupeKey,
} from "./system";

/** A quarter of an hour, which is what the shipped default is. */
const QUIET_MS = 900_000;

const MINUTE = 60_000;

/** An arbitrary instant to count from, so every case reads as a clock. */
const NOW = 1_800_000_000_000;

const at = (msAgo: number) => NOW - msAgo;

describe("startupVerdict", () => {
  it("announces a first ever boot, with nothing to say about downtime", () => {
    const verdict = startupVerdict({
      lastDownAtMs: null,
      lastUpAtMs: null,
      nowMs: NOW,
      quietMs: QUIET_MS,
    });

    expect(verdict).toEqual({
      downtimeMs: null,
      kind: "announce",
      stop: "unrecorded",
    });
  });

  it("dates the downtime from the stop that was announced", () => {
    const verdict = startupVerdict({
      lastDownAtMs: at(4 * MINUTE),
      lastUpAtMs: at(3 * 60 * MINUTE),
      nowMs: NOW,
      quietMs: QUIET_MS,
    });

    expect(verdict).toEqual({
      downtimeMs: 4 * MINUTE,
      kind: "announce",
      stop: "clean",
    });
  });

  it("claims no duration when nothing recorded a stop — a crash or a hard reboot", () => {
    const verdict = startupVerdict({
      lastDownAtMs: null,
      lastUpAtMs: at(3 * 60 * MINUTE),
      nowMs: NOW,
      quietMs: QUIET_MS,
    });

    expect(verdict).toEqual({
      downtimeMs: null,
      kind: "announce",
      stop: "unrecorded",
    });
  });

  it("ignores a stop older than the last start, which belongs to a restart already announced", () => {
    const verdict = startupVerdict({
      lastDownAtMs: at(5 * 60 * MINUTE),
      lastUpAtMs: at(4 * 60 * MINUTE),
      nowMs: NOW,
      quietMs: QUIET_MS,
    });

    expect(verdict).toEqual({
      downtimeMs: null,
      kind: "announce",
      stop: "unrecorded",
    });
  });

  // The crash loop. A supervisor restarting a dying process every few seconds
  // must not produce a message per attempt, and the ledger is the only thing
  // that remembers across those processes.
  it("stays quiet when a start was announced inside the window", () => {
    const verdict = startupVerdict({
      lastDownAtMs: at(30_000),
      lastUpAtMs: at(20_000),
      nowMs: NOW,
      quietMs: QUIET_MS,
    });

    expect(verdict).toEqual({ kind: "silent", reason: "announced_recently" });
  });

  it("speaks again once the window has passed", () => {
    const verdict = startupVerdict({
      lastDownAtMs: null,
      lastUpAtMs: at(QUIET_MS),
      nowMs: NOW,
      quietMs: QUIET_MS,
    });

    expect(verdict.kind).toBe("announce");
  });

  // A clock that went backwards, or two hosts disagreeing. Saying nothing is
  // the safe direction: the other one is the flood the window exists to stop.
  it("treats a mark in the future as recent", () => {
    const verdict = startupVerdict({
      lastDownAtMs: null,
      lastUpAtMs: NOW + MINUTE,
      nowMs: NOW,
      quietMs: QUIET_MS,
    });

    expect(verdict.kind).toBe("silent");
  });

  it("announces every start when the window is turned off", () => {
    const verdict = startupVerdict({
      lastDownAtMs: null,
      lastUpAtMs: at(1),
      nowMs: NOW,
      quietMs: 0,
    });

    expect(verdict.kind).toBe("announce");
  });
});

describe("shutdownVerdict", () => {
  it("announces a stop nothing has announced recently", () => {
    expect(
      shutdownVerdict({
        lastDownAtMs: at(3 * 60 * MINUTE),
        nowMs: NOW,
        quietMs: QUIET_MS,
      })
    ).toEqual({ kind: "announce" });
  });

  it("stays quiet through a restart loop that keeps stopping gracefully", () => {
    expect(
      shutdownVerdict({
        lastDownAtMs: at(10_000),
        nowMs: NOW,
        quietMs: QUIET_MS,
      })
    ).toEqual({ kind: "silent", reason: "announced_recently" });
  });
});

describe("systemDedupeKey", () => {
  // The read and the key have to agree, or two processes reading the ledger at
  // the same instant would both find nothing and both send.
  it("gives two starts inside one window the same key", () => {
    const first = systemDedupeKey({
      kind: "system_up",
      nowMs: NOW,
      quietMs: QUIET_MS,
    });
    const second = systemDedupeKey({
      kind: "system_up",
      nowMs: NOW + 1000,
      quietMs: QUIET_MS,
    });

    expect(second).toBe(first);
  });

  it("gives two starts more than a window apart different keys", () => {
    const first = systemDedupeKey({
      kind: "system_up",
      nowMs: NOW,
      quietMs: QUIET_MS,
    });
    const later = systemDedupeKey({
      kind: "system_up",
      nowMs: NOW + QUIET_MS + 1,
      quietMs: QUIET_MS,
    });

    expect(later).not.toBe(first);
  });

  it("never collides across the two kinds", () => {
    expect(
      systemDedupeKey({ kind: "system_up", nowMs: NOW, quietMs: QUIET_MS })
    ).not.toBe(
      systemDedupeKey({ kind: "system_down", nowMs: NOW, quietMs: QUIET_MS })
    );
  });

  it("still produces a key with the window turned off", () => {
    expect(systemDedupeKey({ kind: "system_up", nowMs: NOW, quietMs: 0 })).toBe(
      `system_up:${NOW}`
    );
  });
});

describe("buildLabel", () => {
  it("shortens a commit to something a person can match against a deploy", () => {
    expect(buildLabel({ gitSha: "abc1234def5678", serviceVersion: null })).toBe(
      "abc1234"
    );
  });

  it("carries both when the deployment states both", () => {
    expect(
      buildLabel({ gitSha: "abc1234def5678", serviceVersion: "1.4.0" })
    ).toBe("1.4.0 (abc1234)");
  });

  it("is nothing at all when the deployment says nothing", () => {
    expect(buildLabel({ gitSha: null, serviceVersion: null })).toBeNull();
  });
});

const NOON = DateTime.makeUnsafe("2026-08-07T09:14:32Z");

describe("renderSystemUp", () => {
  it("says when it came back, how long it was gone and that it was deliberate", () => {
    const text = renderSystemUp({
      at: NOON,
      build: "1.4.0 (abc1234)",
      downtimeMs: 4 * MINUTE,
      stop: "clean",
    });

    expect(text).toContain("System restarted");
    expect(text).toContain("2026-08-07 09:14 UTC");
    expect(text).toContain("4m 0s");
    expect(text).toContain("1.4.0 (abc1234)");
  });

  // The person's next question is "did my message get through", and the poller
  // starts with `dropPendingUpdates`, so the answer is no.
  it("says that what was sent into the silence was not received", () => {
    const text = renderSystemUp({
      at: NOON,
      build: null,
      downtimeMs: null,
      stop: "unrecorded",
    });

    expect(text).toContain("send it again");
  });

  it("names a crash as a crash rather than inventing a duration", () => {
    const text = renderSystemUp({
      at: NOON,
      build: null,
      downtimeMs: null,
      stop: "unrecorded",
    });

    expect(text).toContain("crash or a hard reboot");
    expect(text).not.toContain("down for");
  });

  it("leaves the build line off when nothing said which build this is", () => {
    const text = renderSystemUp({
      at: NOON,
      build: null,
      downtimeMs: 1000,
      stop: "clean",
    });

    expect(text).not.toContain("Running");
  });
});

describe("renderSystemDown", () => {
  it("says it is going, when, and that it will say when it is back", () => {
    const text = renderSystemDown({ at: NOON, build: "abc1234" });

    expect(text).toContain("System going down");
    expect(text).toContain("2026-08-07 09:14 UTC");
    expect(text).toContain("abc1234");
  });
});
