import { describe, expect, test } from "bun:test";
import { TaskId, ThreadId } from "@workspace/domain";
import { Option } from "effect";
import {
  CALLBACK_DATA_MAX_BYTES,
  CALLBACK_VERSION,
  COMPOSE_VERBS,
  decodeCallbackData,
  encodeCallbackData,
  MAX_PAGE,
  TASK_VERBS,
} from "./callback-data";

const TASK_ID = TaskId.make("0195f2a0-1c3d-7a11-8f2e-0b1c2d3e4f50");
const THREAD_ID = ThreadId.make("0195f2a0-1c3d-7a11-8f2e-0b1c2d3e4f51");

describe("encodeCallbackData", () => {
  test.each(TASK_VERBS.map((verb) => [verb] as const))(
    "round-trips %s",
    (verb) => {
      const encoded = encodeCallbackData({
        kind: "task",
        taskId: TASK_ID,
        verb,
      });
      expect(encoded).toBe(`${CALLBACK_VERSION}:${verb}:${TASK_ID}`);
      expect(decodeCallbackData(encoded)).toEqual(
        Option.some({ kind: "task", taskId: TASK_ID, verb })
      );
    }
  );

  test("round-trips a thread switch", () => {
    const encoded = encodeCallbackData({
      kind: "thread",
      threadId: THREAD_ID,
      verb: "thsw",
    });
    expect(decodeCallbackData(encoded)).toEqual(
      Option.some({ kind: "thread", threadId: THREAD_ID, verb: "thsw" })
    );
  });

  test("round-trips a page", () => {
    const encoded = encodeCallbackData({
      key: "threads",
      kind: "page",
      page: 3,
      verb: "pg",
    });
    expect(encoded).toBe(`${CALLBACK_VERSION}:pg:threads:3`);
    expect(decodeCallbackData(encoded)).toEqual(
      Option.some({ key: "threads", kind: "page", page: 3, verb: "pg" })
    );
  });

  test.each(COMPOSE_VERBS.map((verb) => [verb] as const))(
    "round-trips %s, which carries no argument at all",
    (verb) => {
      const encoded = encodeCallbackData({ kind: "compose", verb });
      expect(encoded).toBe(`${CALLBACK_VERSION}:${verb}`);
      expect(decodeCallbackData(encoded)).toEqual(
        Option.some({ kind: "compose", verb })
      );
    }
  );

  test("every button fits Telegram's 64-byte cap", () => {
    for (const verb of TASK_VERBS) {
      const encoded = encodeCallbackData({
        kind: "task",
        taskId: TASK_ID,
        verb,
      });
      expect(Buffer.byteLength(encoded, "utf8")).toBeLessThanOrEqual(
        CALLBACK_DATA_MAX_BYTES
      );
    }
  });
});

describe("decodeCallbackData", () => {
  test.each([
    ["undefined", undefined],
    ["empty", ""],
    ["another version", `v2:tprog:${TASK_ID}`],
    ["no version", `tprog:${TASK_ID}`],
    ["an unknown verb", `${CALLBACK_VERSION}:tnuke:${TASK_ID}`],
    ["no argument", `${CALLBACK_VERSION}:tprog:`],
    ["a missing argument", `${CALLBACK_VERSION}:tprog`],
    ["an argument that is not a uuid", `${CALLBACK_VERSION}:tprog:../../etc`],
    ["an unknown page key", `${CALLBACK_VERSION}:pg:secrets:0`],
    ["a page that is not a number", `${CALLBACK_VERSION}:pg:threads:x`],
    ["a negative page", `${CALLBACK_VERSION}:pg:threads:-1`],
    ["a page past the cap", `${CALLBACK_VERSION}:pg:threads:${MAX_PAGE + 1}`],
    ["an argument on an argument-less verb", `${CALLBACK_VERSION}:cmsnd:1`],
    ["an empty argument on one", `${CALLBACK_VERSION}:cmsnd:`],
  ])("refuses %s", (_name, raw) => {
    expect(Option.isNone(decodeCallbackData(raw))).toBe(true);
  });

  test("does not let a task id stand in for a thread id", () => {
    // Both are uuids on the wire; the brand is what tells them apart, and the
    // verb is what picks the brand.
    const decoded = decodeCallbackData(`${CALLBACK_VERSION}:thsw:${TASK_ID}`);
    expect(Option.isSome(decoded)).toBe(true);
    expect(Option.getOrThrow(decoded).kind).toBe("thread");
  });
});
