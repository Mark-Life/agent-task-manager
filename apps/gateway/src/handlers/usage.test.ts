/**
 * The gateway's half of the published reading: where it looks, and what it says
 * when what it finds is not a reading.
 *
 * Against a real directory rather than a stubbed filesystem, because every case
 * here is a filesystem case — the file is absent, the file is half-written, the
 * file is from a version that did not agree with this one — and a stub would be
 * the thing under test answering for itself.
 */

import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { BunFileSystem } from "@effect/platform-bun";
import { QUOTA_SEGMENT } from "@workspace/domain";
import { Effect } from "effect";
import { publishedUsagePathOf, readPublishedUsage } from "./usage";

const directories: string[] = [];

afterEach(() => {
  for (const directory of directories.splice(0)) {
    rmSync(directory, { force: true, recursive: true });
  }
});

const dataRoot = () => {
  const directory = mkdtempSync(join(tmpdir(), "gateway-usage-"));
  directories.push(directory);
  return directory;
};

const write = (root: string, body: string) => {
  const path = publishedUsagePathOf(root);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, body);
};

const read = (root: string) =>
  Effect.runPromise(
    readPublishedUsage(root).pipe(Effect.provide(BunFileSystem.layer))
  );

/** A reading in the shape the loop publishes, trimmed to one provider. */
const published = JSON.stringify({
  providers: [
    {
      enforced: true,
      note: null,
      pausedUntil: null,
      provider: "claude",
      readAt: "2026-08-07T10:00:00.000Z",
      state: "ok",
      windows: [
        {
          kind: "primary",
          label: "5h",
          remainingPercent: 82,
          resetsAt: "2026-08-07T13:00:00.000Z",
          usedPercent: 18,
          windowSeconds: 18_000,
        },
      ],
    },
  ],
  publishedAt: "2026-08-07T10:00:05.000Z",
});

describe("readPublishedUsage", () => {
  test("looks under the data root where the loop writes", () => {
    expect(publishedUsagePathOf("/srv/atm")).toBe(
      join("/srv/atm", QUOTA_SEGMENT, "usage.json")
    );
  });

  test("serves what the loop published", async () => {
    const root = dataRoot();
    write(root, published);
    const snapshot = await read(root);
    expect(snapshot.publishedAt).not.toBeNull();
    expect(snapshot.providers).toHaveLength(1);
    expect(snapshot.providers[0]?.windows[0]?.remainingPercent).toBe(82);
    expect(snapshot.providers[0]?.windows[0]?.label).toBe("5h");
  });

  test("nothing published reads as nothing published, not as an error", async () => {
    const snapshot = await read(dataRoot());
    expect(snapshot.publishedAt).toBeNull();
    expect(snapshot.providers).toHaveLength(0);
  });

  test("a document this gateway cannot read is the same answer, loudly", async () => {
    const root = dataRoot();
    write(root, '{"providers":[{"provider":"pi"}],"publishedAt":null}');
    const snapshot = await read(root);
    expect(snapshot.providers).toHaveLength(0);
  });

  test("a half-written file does not take the endpoint down", async () => {
    const root = dataRoot();
    write(root, '{"providers":[');
    const snapshot = await read(root);
    expect(snapshot.providers).toHaveLength(0);
  });
});
