import { describe, expect, test } from "bun:test";
import { newRunId, newTaskId } from "@workspace/domain";
import { RateLimited } from "@workspace/harness";
import { CloneFailed, MountSourceMissing, OomKilled } from "@workspace/sandbox";
import {
  AlreadyLive,
  classifyFailure,
  describeFailure,
  errorClassOf,
  LeaseLost,
  RUN_ERROR_CLASSES,
  runOutcomeOfClass,
} from "./errors";

const runId = newRunId();
const subject = { id: newTaskId(), kind: "task" } as const;

describe("classifyFailure", () => {
  test("names the loop's own failures", () => {
    expect(classifyFailure(new AlreadyLive({ runId, subject }))).toBe(
      "AlreadyLive"
    );
    expect(
      classifyFailure(new LeaseLost({ detail: "expired", runId, subject }))
    ).toBe("LeaseLost");
  });

  test("keeps the sandbox's name for a container failure", () => {
    expect(
      classifyFailure(new OomKilled({ containerId: null, limitMb: 2048 }))
    ).toBe("OomKilled");
  });

  test("keeps the harness's name for a provider failure", () => {
    expect(classifyFailure(new RateLimited({ retryAfterMs: null }))).toBe(
      "RateLimited"
    );
  });

  test("calls a database failure by one name, whichever repository raised it", () => {
    expect(classifyFailure({ _tag: "Db.PersistenceError" })).toBe(
      "PersistenceFailed"
    );
    expect(classifyFailure({ _tag: "TaskRepo.IllegalTransition" })).toBe(
      "PersistenceFailed"
    );
  });

  test("reads a live-run refusal as the skip it is, not as a database fault", () => {
    expect(classifyFailure({ _tag: "RunRepo.AlreadyLive" })).toBe(
      "AlreadyLive"
    );
  });

  test("falls back to the harness's text matching for anything untagged", () => {
    expect(classifyFailure(new Error("429 too many requests"))).toBe(
      "RateLimited"
    );
    expect(classifyFailure("nothing recognizable here")).toBe("Unknown");
  });
});

describe("runOutcomeOfClass", () => {
  test("is total over every class a run can carry", () => {
    for (const errorClass of RUN_ERROR_CLASSES) {
      expect(runOutcomeOfClass(errorClass)).toBeString();
    }
  });

  test("keeps the three endings that are not plain errors apart", () => {
    expect(runOutcomeOfClass("Interrupted")).toBe("interrupted");
    expect(runOutcomeOfClass("TimedOut")).toBe("timeout");
    expect(runOutcomeOfClass("NoTerminalEvent")).toBe("lost");
    expect(runOutcomeOfClass("DispatchFailed")).toBe("errored");
  });
});

describe("describeFailure", () => {
  test("gives a crash message its class, its message and its outcome", () => {
    expect(
      describeFailure(new LeaseLost({ detail: "reclaimed", runId, subject }))
    ).toEqual({
      errorClass: "LeaseLost",
      errorMessage: "reclaimed",
      outcome: "errored",
    });
  });

  test("redacts a credential the provider printed", () => {
    const described = describeFailure(
      new Error("refused: Bearer sk-abcdefghijklmnop")
    );
    expect(described.errorMessage).not.toContain("abcdefghijklmnop");
  });

  test("never leaves the message empty, since a blank row explains nothing", () => {
    expect(describeFailure({}).errorMessage).toBe("Unknown");
  });

  /**
   * A sandbox failure used to arrive as its bare tag and a colon, because these
   * tags are not in the loop's own table and the fallback reads `message` off an
   * `Error` that never had one. Everything worth knowing was already on the
   * error and reached nobody.
   */
  test("says why a checkout failed, not just that it did", () => {
    const described = describeFailure(
      new CloneFailed({
        exitCode: 128,
        repo: "Mark-Life/agent-task-manager",
        stderr: "fatal: could not read Username for 'https://github.com'",
      })
    );
    expect(described.errorClass).toBe("CloneFailed");
    expect(described.errorMessage).toBe(
      "cloning Mark-Life/agent-task-manager failed (exit 128): fatal: could not read Username for 'https://github.com'"
    );
  });

  test("names the limit a container was killed for exceeding", () => {
    expect(
      describeFailure(new OomKilled({ containerId: "abc", limitMb: 2048 }))
        .errorMessage
    ).toBe("the kernel killed the container for exceeding its 2048MB limit");
  });

  test("names the path a mount pointed at", () => {
    expect(
      describeFailure(
        new MountSourceMissing({
          hostPath: "/var/lib/atm/bin/turn.js",
          purpose: "entrypoint",
        })
      ).errorMessage
    ).toBe(
      "the entrypoint mount points at /var/lib/atm/bin/turn.js, which does not exist"
    );
  });

  /**
   * git quotes the remote in its own error text, and the remote is where a
   * token would be. The sanitizer runs over the assembled sentence, not over
   * the fields, so it covers whatever a tool decided to print.
   */
  test("redacts a credential git printed back", () => {
    const described = describeFailure(
      new CloneFailed({
        exitCode: 128,
        repo: "owner/name",
        stderr:
          "fatal: unable to access 'https://x:ghp_abcdefghijklmnopqrst@github.com/owner/name'",
      })
    );
    expect(described.errorMessage).not.toContain("ghp_abcdefghijklmnopqrst");
  });
});

describe("errorClassOf", () => {
  test("maps a typed failure to the name that lands on the row", () => {
    expect(errorClassOf(new AlreadyLive({ runId: null, subject }))).toBe(
      "AlreadyLive"
    );
  });
});
