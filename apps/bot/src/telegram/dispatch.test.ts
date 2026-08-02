import { describe, expect, test } from "bun:test";
import { TaskId } from "@workspace/domain";
import { BOT_COMMANDS, HELP_TEXT } from "./commands";
import { makePendingComments } from "./dispatch";
import { BUTTON_COMMANDS } from "./keyboard";

const TASK_ID = TaskId.make("0195f2a0-1c3d-7a11-8f2e-0b1c2d3e4f50");
const OTHER_TASK_ID = TaskId.make("0195f2a0-1c3d-7a11-8f2e-0b1c2d3e4f51");

const CHAT = 4242;
const OTHER_CHAT = -100_123;

/** Telegram's own rule for what a command may be called. */
const COMMAND_NAME = /^[a-z0-9_]{1,32}$/;

const names: readonly string[] = BOT_COMMANDS.map((entry) => entry.command);

describe("BOT_COMMANDS", () => {
  test("every name is one Telegram will accept", () => {
    for (const name of names) {
      expect(name).toMatch(COMMAND_NAME);
    }
  });

  test("no name is registered twice", () => {
    expect(new Set(names).size).toBe(names.length);
  });

  test("every description is short enough to read in the menu", () => {
    for (const entry of BOT_COMMANDS) {
      expect(entry.description.length).toBeGreaterThan(0);
      expect(entry.description.length).toBeLessThanOrEqual(256);
    }
  });

  test("every reply-keyboard button stands for a registered command", () => {
    for (const command of Object.values(BUTTON_COMMANDS)) {
      expect(names).toContain(command.replace("/", ""));
    }
  });

  test("help names every command", () => {
    for (const name of names.filter((entry) => entry !== "help")) {
      expect(HELP_TEXT).toContain(`/${name}`);
    }
  });
});

describe("makePendingComments", () => {
  test("an armed chat yields its task once", () => {
    const pending = makePendingComments();
    pending.arm({ chatId: CHAT, taskId: TASK_ID });

    expect(pending.take(CHAT)).toBe(TASK_ID);
    expect(pending.take(CHAT)).toBeNull();
  });

  test("an unarmed chat yields nothing", () => {
    expect(makePendingComments().take(CHAT)).toBeNull();
  });

  test("arming one chat leaves another alone", () => {
    const pending = makePendingComments();
    pending.arm({ chatId: CHAT, taskId: TASK_ID });

    expect(pending.take(OTHER_CHAT)).toBeNull();
    expect(pending.take(CHAT)).toBe(TASK_ID);
  });

  test("a second tap replaces the task the chat is armed for", () => {
    const pending = makePendingComments();
    pending.arm({ chatId: CHAT, taskId: TASK_ID });
    pending.arm({ chatId: CHAT, taskId: OTHER_TASK_ID });

    expect(pending.take(CHAT)).toBe(OTHER_TASK_ID);
  });
});
