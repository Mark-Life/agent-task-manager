import { describe, expect, test } from "bun:test";
import { ChatMessageRepo, ChatThreadRepo, RunRepo } from "@workspace/db";
import type { ChatMessage, ChatThread, Run } from "@workspace/domain";
import {
  RunId,
  TelegramChatId,
  ThreadId,
  WorkspaceId,
} from "@workspace/domain";
import { Effect, Layer } from "effect";
import { lastTextOf, recordingApi } from "../testing/telegram";
import {
  answerText,
  deliverAnswer,
  FORCE_SEND_LABEL,
  forceSendKeyboard,
  makeQueueNotices,
  queuedText,
} from "./answer";
import { BotService } from "./bot-service";
import { decodeCallbackData } from "./callback-data";

const THREAD_ID = ThreadId.make("0195f2a0-1c3d-7a11-8f2e-0b1c2d3e4f60");
const OTHER_THREAD_ID = ThreadId.make("0195f2a0-1c3d-7a11-8f2e-0b1c2d3e4f61");
const RUN_ID = RunId.make("0195f2a0-1c3d-7a11-8f2e-0b1c2d3e4f62");
const WORKSPACE_ID = WorkspaceId.make("0195f2a0-1c3d-7a11-8f2e-0b1c2d3e4f63");
const CHAT_ID = TelegramChatId.make(4242);

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

/**
 * A conversation that is being closed out while the bot reads it.
 *
 * The listener is woken by the run's terminal event, which the ingest appends
 * before the run row closes and before the manager's message is stored — so a
 * store this test drives has to be able to answer "still running, nothing said"
 * first and the truth a moment later. `closesAfterMs` is where that moment is.
 */
const closingStore = (options: {
  readonly closesAfterMs: number;
  readonly spoken: string | null;
}) => {
  const openedAt = Date.now();
  const closed = () => Date.now() - openedAt >= options.closesAfterMs;

  const runs = Layer.succeed(RunRepo, {
    byId: () =>
      Effect.sync(
        () =>
          ({
            costUsd: null,
            durationMs: null,
            errorClass: null,
            errorMessage: null,
            id: RUN_ID,
            outcome: closed() ? "done" : null,
            status: closed() ? "finished" : "running",
            threadId: THREAD_ID,
            totalTokens: null,
            turns: null,
            workspaceId: WORKSPACE_ID,
          }) as unknown as Run
      ),
  } as unknown as RunRepo["Service"]);

  const threads = Layer.succeed(ChatThreadRepo, {
    byId: () =>
      Effect.succeed({
        chatId: CHAT_ID,
        id: THREAD_ID,
        workspaceId: WORKSPACE_ID,
      } as unknown as ChatThread),
  } as unknown as ChatThreadRepo["Service"]);

  const messages = Layer.succeed(ChatMessageRepo, {
    recent: () =>
      Effect.sync(() =>
        options.spoken === null || !closed()
          ? []
          : [
              { body: "hello", role: "user", runId: null },
              {
                body: options.spoken,
                role: "manager",
                runId: RUN_ID,
              },
            ].map((row) => row as unknown as ChatMessage)
      ),
  } as unknown as ChatMessageRepo["Service"]);

  return Layer.mergeAll(messages, runs, threads);
};

describe("deliverAnswer", () => {
  test("the answer of a turn still closing out is waited for, not written off", async () => {
    const telegram = recordingApi();
    const notices = makeQueueNotices();
    notices.next({ messageId: STATUS_MESSAGE, threadId: THREAD_ID });
    const spoken = "Loud and clear. Board's here whenever you want to file.";

    await Effect.runPromise(
      deliverAnswer({
        notices,
        run: { id: RUN_ID, workspaceId: WORKSPACE_ID },
      }).pipe(
        Effect.provide(
          Layer.mergeAll(
            closingStore({ closesAfterMs: 700, spoken }),
            Layer.succeed(BotService, {
              api: telegram.api,
            } as unknown as BotService["Service"])
          )
        )
      )
    );

    const said = lastTextOf({ calls: telegram.calls, method: "sendMessage" });
    expect(said).toContain(spoken);
    expect(said).not.toContain("without an answer");
    expect(
      telegram.calls.some((call) => call.method === "deleteMessage")
    ).toBeTrue();
  });

  test("a turn that really said nothing is reported as one, once it has ended", async () => {
    const telegram = recordingApi();

    await Effect.runPromise(
      deliverAnswer({
        notices: makeQueueNotices(),
        run: { id: RUN_ID, workspaceId: WORKSPACE_ID },
      }).pipe(
        Effect.provide(
          Layer.mergeAll(
            closingStore({ closesAfterMs: 0, spoken: null }),
            Layer.succeed(BotService, {
              api: telegram.api,
            } as unknown as BotService["Service"])
          )
        )
      )
    );

    const said = lastTextOf({ calls: telegram.calls, method: "sendMessage" });
    expect(said).toContain("without an answer");
    expect(said).toContain("done");
  });
});
