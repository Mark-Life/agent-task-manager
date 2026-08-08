import { describe, expect, test } from "bun:test";
import { TaskId } from "@workspace/domain";
import { Schema } from "effect";
import { isHttpUrl, prettyUrl, taskUrl } from "@/lib/url";

const taskId = Schema.decodeUnknownSync(TaskId)(
  "019fde03-c096-790d-8a22-70089c89d04d"
);

describe("taskUrl", () => {
  test("addresses the task the way the bot and the route do", () => {
    expect(taskUrl(taskId, "https://board.example.com")).toBe(
      "https://board.example.com/tasks/019fde03-c096-790d-8a22-70089c89d04d"
    );
  });

  test("carries the id verbatim, so it can be read back out", () => {
    const url = new URL(taskUrl(taskId, "https://board.example.com"));
    expect(url.pathname.split("/").at(-1)).toBe(taskId);
  });

  test("does not double the slash on an origin that ends in one", () => {
    expect(taskUrl(taskId, "https://board.example.com/")).toBe(
      "https://board.example.com/tasks/019fde03-c096-790d-8a22-70089c89d04d"
    );
  });

  test("is a link a person can open", () => {
    expect(isHttpUrl(taskUrl(taskId, "http://localhost:3000"))).toBe(true);
  });
});

describe("prettyUrl", () => {
  test("shortens a pull request to what a reader says out loud", () => {
    expect(
      prettyUrl("https://github.com/Mark-Life/agent-task-manager/pull/1")
    ).toBe("Mark-Life/agent-task-manager#1");
  });
});
