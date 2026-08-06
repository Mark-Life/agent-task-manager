import { describe, expect, test } from "bun:test";
import { TASK_STATUSES, TaskId, ThreadId } from "@workspace/domain";
import type { InlineKeyboard } from "grammy";
import { CALLBACK_DATA_MAX_BYTES } from "./callback-data";
import {
  BUTTON_COMMANDS,
  commandForButton,
  mainKeyboard,
  runNoticeKeyboard,
  taskKeyboard,
  threadSwitchKeyboard,
} from "./keyboard";

const TASK_ID = TaskId.make("0195f2a0-1c3d-7a11-8f2e-0b1c2d3e4f50");
const THREAD_ID = ThreadId.make("0195f2a0-1c3d-7a11-8f2e-0b1c2d3e4f51");

const labels = (keyboard: InlineKeyboard) =>
  keyboard.inline_keyboard.flat().map((button) => button.text);

describe("mainKeyboard", () => {
  test("every key stands for a command", () => {
    for (const key of mainKeyboard.keyboard.flat()) {
      const label = typeof key === "string" ? key : key.text;
      expect(commandForButton(label)).not.toBeNull();
    }
  });

  test("every command it offers starts with a slash", () => {
    for (const command of Object.values(BUTTON_COMMANDS)) {
      expect(command.startsWith("/")).toBe(true);
    }
  });

  test("leads with Compose, then Tasks", () => {
    const keys = mainKeyboard.keyboard
      .flat()
      .map((key) => (typeof key === "string" ? key : key.text));
    expect(keys.slice(0, 2)).toEqual(["Compose", "Tasks"]);
  });

  test("offers every command it maps a label for", () => {
    const keys = new Set(
      mainKeyboard.keyboard
        .flat()
        .map((key) => (typeof key === "string" ? key : key.text))
    );
    expect(keys).toEqual(new Set(Object.keys(BUTTON_COMMANDS)));
  });

  test("ordinary text is not a command", () => {
    expect(commandForButton("ship it")).toBeNull();
    expect(commandForButton(undefined)).toBeNull();
  });
});

describe("taskKeyboard", () => {
  test.each([
    ["ideas", ["Start", "Comment"]],
    ["backlog", ["Start", "Comment"]],
    ["review", ["Approve", "Rerun", "Comment"]],
    ["done", ["Rerun", "Comment"]],
  ] as const)("offers %s the moves it allows", (status, expected) => {
    const keyboard = taskKeyboard({
      hasLiveRun: false,
      status,
      taskId: TASK_ID,
    });
    expect(labels(keyboard)).toEqual([...expected]);
  });

  test("offers Stop only while a run is live", () => {
    expect(
      labels(
        taskKeyboard({
          hasLiveRun: true,
          status: "in_progress",
          taskId: TASK_ID,
        })
      )
    ).toEqual(["Stop", "Review", "Comment"]);
    expect(
      labels(
        taskKeyboard({
          hasLiveRun: false,
          status: "in_progress",
          taskId: TASK_ID,
        })
      )
    ).toEqual(["Review", "Rerun", "Comment"]);
  });

  test("adds the link only when there is one", () => {
    expect(
      labels(
        taskKeyboard({
          hasLiveRun: false,
          status: "done",
          taskId: TASK_ID,
          taskUrl: "https://board.example/tasks/1",
        })
      )
    ).toContain("Open");
  });

  test("every status produces buttons inside the callback-data cap", () => {
    for (const status of TASK_STATUSES) {
      const keyboard = taskKeyboard({
        hasLiveRun: true,
        status,
        taskId: TASK_ID,
      });
      for (const button of keyboard.inline_keyboard.flat()) {
        if ("callback_data" in button) {
          expect(
            Buffer.byteLength(button.callback_data, "utf8")
          ).toBeLessThanOrEqual(CALLBACK_DATA_MAX_BYTES);
        }
      }
    }
  });

  test("leaves no empty row behind", () => {
    const keyboard = taskKeyboard({
      hasLiveRun: false,
      status: "done",
      taskId: TASK_ID,
    });
    for (const row of keyboard.inline_keyboard) {
      expect(row.length).toBeGreaterThan(0);
    }
  });
});

describe("runNoticeKeyboard", () => {
  test("offers run control and nothing that moves the board", () => {
    expect(labels(runNoticeKeyboard({ taskId: TASK_ID }))).toEqual([
      "Stop",
      "Rerun",
      "Comment",
    ]);
  });
});

describe("threadSwitchKeyboard", () => {
  test("draws one row per thread", () => {
    const keyboard = threadSwitchKeyboard([
      { id: THREAD_ID, label: "billing bug" },
    ]);
    expect(keyboard.inline_keyboard).toHaveLength(1);
    expect(labels(keyboard)).toEqual(["billing bug"]);
  });

  test("draws nothing for no threads", () => {
    expect(threadSwitchKeyboard([]).inline_keyboard).toEqual([]);
  });
});
