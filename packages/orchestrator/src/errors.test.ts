import { describe, expect, test } from "bun:test";
import { newRunId, newTaskId } from "@workspace/domain";
import { RateLimited } from "@workspace/harness";
import { OomKilled } from "@workspace/sandbox";
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
  test("gives a crash comment its class, its message and its outcome", () => {
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
});

describe("errorClassOf", () => {
  test("maps a typed failure to the name that lands on the row", () => {
    expect(errorClassOf(new AlreadyLive({ runId: null, subject }))).toBe(
      "AlreadyLive"
    );
  });
});
