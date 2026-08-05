/**
 * The reader's half of a rolling credential: what the tools authenticate with
 * is what is in the file *now*.
 *
 * The whole arrangement rests on this. The host rewrites the credential while
 * the turn runs, so a server that read it once at startup — as this one used to
 * — would present the same expiring token for the length of the run and be
 * refused for the rest of it. And the file being taken away is the only way
 * this token shape can be recalled early, so a reader that kept a copy would
 * turn that revocation into nothing at all.
 */

import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Effect, Redacted } from "effect";
import { currentGatewayToken } from "./config";

const directories: string[] = [];

afterEach(() => {
  for (const directory of directories.splice(0)) {
    rmSync(directory, { force: true, recursive: true });
  }
});

/** A run directory of this test's own, cleaned up after it. */
const runDir = () => {
  const dir = mkdtempSync(join(tmpdir(), "atm-credential-"));
  directories.push(dir);
  return dir;
};

/** The token a request would carry, or the reason there was none. */
const read = (path: string) =>
  Effect.runPromise(
    currentGatewayToken({ kind: "file", path }).pipe(
      Effect.map(Redacted.value),
      Effect.catchTag("AgentTools.GatewayTokenUnreadable", (failure) =>
        Effect.succeed(failure._tag)
      )
    )
  );

describe("a credential read from a file", () => {
  test("carries what the host wrote there most recently", async () => {
    const path = join(runDir(), "agent-token");
    writeFileSync(path, "atm1.first");
    expect(await read(path)).toBe("atm1.first");

    // The refresh, as the host performs it: the same path, a new token.
    writeFileSync(path, "atm1.second");
    expect(await read(path)).toBe("atm1.second");
  });

  test("keeps nothing once the file is gone", async () => {
    const dir = runDir();
    const path = join(dir, "agent-token");
    writeFileSync(path, "atm1.live");
    expect(await read(path)).toBe("atm1.live");

    rmSync(path);
    expect(await read(path)).toBe("AgentTools.GatewayTokenUnreadable");
  });

  test("treats an empty file as no credential rather than as an empty one", async () => {
    const path = join(runDir(), "agent-token");
    writeFileSync(path, "");
    expect(await read(path)).toBe("AgentTools.GatewayTokenUnreadable");
  });

  test("ignores the newline a writer leaves behind", async () => {
    const path = join(runDir(), "agent-token");
    writeFileSync(path, "atm1.token\n");
    expect(await read(path)).toBe("atm1.token");
  });
});

describe("a credential given as a value", () => {
  test("is what every request carries, with no file to read", async () => {
    const token = await Effect.runPromise(
      currentGatewayToken({
        kind: "value",
        token: Redacted.make("atm1.fixed"),
      }).pipe(Effect.map(Redacted.value))
    );
    expect(token).toBe("atm1.fixed");
  });
});
