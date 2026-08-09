import { describe, expect, it } from "bun:test";
import { TaskId } from "@workspace/domain";
import { NOTICE_QUOTE_MAX_CHARS, type RunNotice, renderNotice } from "./render";
import { notifyKindOf } from "./summary";

const TASK_ID = TaskId.make("0199a000-0000-7000-8000-0000000000a1");

const notice = (patch: Partial<RunNotice> = {}): RunNotice => ({
  costUsd: null,
  durationMs: null,
  errorMessage: null,
  hasLiveRun: false,
  kind: "run_finished",
  lastMessage: null,
  outcome: "done",
  taskId: TASK_ID,
  taskStatus: "in_progress",
  taskTitle: "Wire the webhook",
  totalTokens: null,
  turns: null,
  ...patch,
});

/** Every button's label, in the order Telegram will show them. */
const labels = (keyboard: ReturnType<typeof renderNotice>["keyboard"]) =>
  keyboard.inline_keyboard.flat().map((button) => button.text);

describe("renderNotice", () => {
  it("names the task, its outcome and what the run cost", () => {
    const { text } = renderNotice({
      notice: notice({ costUsd: 0.1234, durationMs: 42_000, turns: 3 }),
      taskUrl: null,
    });

    expect(text).toContain("Run finished");
    expect(text).toContain("Wire the webhook");
    expect(text).toContain(TASK_ID);
    expect(text).toContain("done");
    expect(text).toContain("$0.1234");
    expect(text).toContain("42.0s");
  });

  it("shows no economics at all when the run produced none", () => {
    const { text } = renderNotice({ notice: notice(), taskUrl: null });

    expect(text).not.toContain("$");
    expect(text).not.toContain("tokens");
    expect(text).not.toContain("0.0s");
  });

  it("carries the failure's own sentence and no transcript", () => {
    const { text } = renderNotice({
      notice: notice({
        errorMessage: "Harness.TimedOut: the turn ran past its cap",
        kind: "run_failed",
        outcome: "timeout",
      }),
      taskUrl: null,
    });

    expect(text).toContain("Run failed");
    expect(text).toContain("Harness.TimedOut");
    expect(text.split("\n").length).toBeLessThan(6);
  });

  it("clips the run's last words rather than pasting a wall of them", () => {
    const { text } = renderNotice({
      notice: notice({ lastMessage: "x".repeat(NOTICE_QUOTE_MAX_CHARS + 500) }),
      taskUrl: null,
    });

    expect(text).toContain("…");
    expect(text.length).toBeLessThan(NOTICE_QUOTE_MAX_CHARS + 300);
  });

  it("offers Approve on a review notice and Start on an untouched task", () => {
    const review = renderNotice({
      notice: notice({ kind: "needs_review", taskStatus: "review" }),
      taskUrl: null,
    });
    const backlog = renderNotice({
      notice: notice({ taskStatus: "backlog" }),
      taskUrl: null,
    });

    expect(labels(review.keyboard)).toContain("Approve");
    expect(labels(review.keyboard)).toContain("Message");
    expect(labels(backlog.keyboard)).toContain("Start");
    expect(labels(backlog.keyboard)).not.toContain("Approve");
  });

  it("offers Stop only while a container is still working", () => {
    const live = renderNotice({
      notice: notice({ hasLiveRun: true, kind: "stuck", outcome: null }),
      taskUrl: null,
    });

    expect(labels(live.keyboard)).toContain("Stop");
    expect(labels(live.keyboard)).not.toContain("Rerun");
  });

  it("adds the dashboard link only when there is a public URL", () => {
    const linked = renderNotice({
      notice: notice(),
      taskUrl: "https://atm.example.com/tasks/1",
    });

    expect(labels(linked.keyboard)).toContain("Open");
    expect(labels(renderNotice({ notice: notice() }).keyboard)).not.toContain(
      "Open"
    );
  });
});

describe("notifyKindOf", () => {
  const task = (status: "in_progress" | "review") =>
    ({ status }) as Parameters<typeof notifyKindOf>[0]["task"];

  const run = (patch: { outcome: string | null; status: string }) =>
    patch as unknown as Parameters<typeof notifyKindOf>[0]["run"];

  it("calls a clean run that left work in review a review request", () => {
    expect(
      notifyKindOf({
        eventKind: "finished",
        run: run({ outcome: "done", status: "finished" }),
        task: task("review"),
      })
    ).toBe("needs_review");
  });

  it("calls a clean run anywhere else a finish", () => {
    expect(
      notifyKindOf({
        eventKind: "finished",
        run: run({ outcome: "done", status: "finished" }),
        task: task("in_progress"),
      })
    ).toBe("run_finished");
  });

  it("calls every other ending a failure, including a deliberate stop", () => {
    expect(
      notifyKindOf({
        eventKind: "stopped",
        run: run({ outcome: "stopped", status: "interrupted" }),
        task: task("in_progress"),
      })
    ).toBe("run_failed");
  });

  it("falls back to the event when the run row has not closed yet", () => {
    expect(
      notifyKindOf({
        eventKind: "finished",
        run: run({ outcome: null, status: "running" }),
        task: task("in_progress"),
      })
    ).toBe("run_finished");
  });

  it("says nothing about a run that is merely talking", () => {
    expect(
      notifyKindOf({
        eventKind: null,
        run: run({ outcome: null, status: "running" }),
        task: task("in_progress"),
      })
    ).toBeNull();
  });
});
