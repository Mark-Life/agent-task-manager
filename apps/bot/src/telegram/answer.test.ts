import { describe, expect, test } from "bun:test";
import { RunId, ThreadId } from "@workspace/domain";
import {
  answerText,
  FORCE_SEND_LABEL,
  forceSendKeyboard,
  makeQueueNotices,
  queuedText,
} from "./answer";
import { decodeCallbackData } from "./callback-data";

const THREAD_ID = ThreadId.make("0195f2a0-1c3d-7a11-8f2e-0b1c2d3e4f60");
const OTHER_THREAD_ID = ThreadId.make("0195f2a0-1c3d-7a11-8f2e-0b1c2d3e4f61");
const RUN_ID = RunId.make("0195f2a0-1c3d-7a11-8f2e-0b1c2d3e4f62");

const STATUS_MESSAGE = 4242;

/** A finished manager turn, with only the fields the answer reads. */
const run = (over: Partial<Parameters<typeof answerText>[0]["run"]> = {}) =>
  ({
    costUsd: null,
    durationMs: null,
    errorClass: null,
    id: RUN_ID,
    outcome: "done",
    status: "finished",
    totalTokens: null,
    turns: null,
    ...over,
  }) as Parameters<typeof answerText>[0]["run"];

/** One row of a conversation, with only the fields the answer reads. */
const message = (body: string) =>
  ({ body }) as Parameters<typeof answerText>[0]["answer"];

describe("makeQueueNotices", () => {
  test("the first queued message opens one status line", () => {
    const notices = makeQueueNotices();
    expect(notices.peek(THREAD_ID)).toBeNull();

    notices.next({ messageId: STATUS_MESSAGE, threadId: THREAD_ID });

    expect(notices.peek(THREAD_ID)?.messageId).toBe(STATUS_MESSAGE);
    expect(notices.count(THREAD_ID)).toBe(1);
  });

  test("more queued messages coalesce into the same line", () => {
    const notices = makeQueueNotices();
    notices.next({ messageId: STATUS_MESSAGE, threadId: THREAD_ID });
    notices.next({ messageId: STATUS_MESSAGE, threadId: THREAD_ID });
    notices.next({ messageId: STATUS_MESSAGE, threadId: THREAD_ID });

    expect(notices.count(THREAD_ID)).toBe(3);
    expect(notices.peek(THREAD_ID)?.messageId).toBe(STATUS_MESSAGE);
  });

  test("one conversation's queue is not another's", () => {
    const notices = makeQueueNotices();
    notices.next({ messageId: STATUS_MESSAGE, threadId: THREAD_ID });

    expect(notices.count(OTHER_THREAD_ID)).toBe(0);
  });

  test("the answer takes the line down, once", () => {
    const notices = makeQueueNotices();
    notices.next({ messageId: STATUS_MESSAGE, threadId: THREAD_ID });

    expect(notices.clear(THREAD_ID)?.messageId).toBe(STATUS_MESSAGE);
    expect(notices.clear(THREAD_ID)).toBeNull();
    expect(notices.count(THREAD_ID)).toBe(0);
  });
});

describe("queuedText", () => {
  test("one waiting message reads as one", () => {
    expect(queuedText(1)).toContain("queued");
    expect(queuedText(1)).not.toContain("1 messages");
  });

  test("several say how many are waiting", () => {
    expect(queuedText(3)).toContain("3 messages");
  });
});

describe("forceSendKeyboard", () => {
  test("the button decodes back to a force send on its own thread", () => {
    const [row] = forceSendKeyboard(THREAD_ID).inline_keyboard;
    const button = row?.[0];
    const decoded = decodeCallbackData(
      (button as { callback_data?: string } | undefined)?.callback_data
    );

    expect(button?.text).toBe(FORCE_SEND_LABEL);
    expect(decoded._tag).toBe("Some");
    expect(decoded._tag === "Some" && decoded.value).toEqual({
      kind: "thread",
      threadId: THREAD_ID,
      verb: "thfs",
    });
  });
});

describe("answerText", () => {
  test("what the model said is escaped, never parsed", () => {
    const rendered = answerText({
      answer: message("use <Thing> & go"),
      run: run(),
    });

    expect(rendered).toContain("&lt;Thing&gt; &amp; go");
  });

  test("the economics land under the answer when there are any", () => {
    const rendered = answerText({
      answer: message("done"),
      run: run({ durationMs: 61_000, totalTokens: 4200 }),
    });

    expect(rendered).toContain("done");
    expect(rendered).toContain("4.2k tokens");
  });

  test("a turn that answered nothing says how it ended", () => {
    const rendered = answerText({
      answer: null,
      run: run({
        errorClass: "Sandbox.ContainerFailed",
        outcome: "errored",
        status: "failed",
      }),
    });

    expect(rendered).toContain("errored");
    expect(rendered).toContain("Sandbox.ContainerFailed");
  });
});
