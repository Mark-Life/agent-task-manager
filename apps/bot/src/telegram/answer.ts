/**
 * What the bot says about a turn it does not run: *queued*, and the answer.
 *
 * The bot writes the person's message and stops. A trigger on `chat_message`
 * wakes the orchestrator, which claims the thread, runs the turn and writes the
 * answer back as another row. So both things this module says are read off the
 * database rather than out of a container the bot is holding.
 *
 * **One status message per thread, edited rather than repeated.** A second
 * message that arrives mid-turn does not get a second "still working" reply: the
 * one already in the chat is rewritten with the new count. Three messages while
 * a turn runs leave one line saying three are waiting, which is what a person
 * sees when they change their mind twice — and the turn after this one reads all
 * three, because they are all still unread. Nothing coalesces them here; the
 * session watermark does.
 *
 * **Force Send is a stop, not a bypass.** The button files a stop naming the
 * thread. The live turn is interrupted, the messages that arrived after it built
 * its prompt are still unread, and the next dispatch resumes the same provider
 * session with them appended. There is no second path into a container and this
 * module does not have one.
 *
 * **The answer is rendered at the end of the turn.** Nothing streams here: the
 * bot hears the run's terminal event, reads the answer row the turn wrote, and
 * sends it once. The model's own Markdown is sent as Markdown, through
 * `sendRichMessage`, which parses it server-side — and a body Telegram refuses
 * to parse falls back to a plain send of the same words, because a code fence
 * that costs a person their answer is the failure that matters here.
 *
 * **The terminal event is not the last write of the turn.** It is appended by
 * the ingest while the container is still shutting down, and the run's outcome
 * and the manager's message land after it. A reader that answered the instant
 * it was woken would find a run still marked `running` and a conversation with
 * nothing in it, and would say so — "the turn ended running without an answer",
 * about a turn that answered. So both reads settle: see `../settle`.
 */

import { ChatMessageRepo, ChatThreadRepo, RunRepo } from "@workspace/db";
import type {
  ChatMessage,
  Run,
  RunId,
  ThreadId,
  WorkspaceId,
} from "@workspace/domain";
import { Effect } from "effect";
import { InlineKeyboard } from "grammy";
import { settle, settledRun } from "../settle";
import { BotService } from "./bot-service";
import { encodeCallbackData } from "./callback-data";
import { FOOTER_SEPARATOR, footerParts } from "./format";
import type { KeyboardRefresh } from "./keyboard";
import { deleteMessage, editText, sendRich, sendText } from "./send";

/** How Telegram is told to parse everything this module composes. */
const HTML = { parse_mode: "HTML" } as const;

/** What the button under a queued message says it will do. */
export const FORCE_SEND_LABEL = "Force send — stops the current turn";

/** What a person is told when their message arrived mid-turn. */
export const queuedText = (waiting: number) =>
  waiting === 1
    ? "Still working — your message is queued and the next turn will read it."
    : `Still working — ${waiting} messages queued, and the next turn reads them together.`;

/** The one button under that line. */
export const forceSendKeyboard = (threadId: ThreadId) =>
  new InlineKeyboard([
    [
      InlineKeyboard.text(
        FORCE_SEND_LABEL,
        encodeCallbackData({ kind: "thread", threadId, verb: "thfs" })
      ),
    ],
  ]);

/** The status message standing in one chat, and how many messages it counts. */
interface QueueNotice {
  readonly messageId: number;
  readonly waiting: number;
}

/**
 * The per-thread status messages, in memory.
 *
 * Deliberately not durable: it holds a Telegram message id, which is a fact
 * about a chat rather than about the conversation, and a restart that forgot one
 * costs a stale line nobody taps. The queue itself is in Postgres — these are
 * unread `chat_message` rows — so nothing a person said is in here.
 */
export interface QueueNotices {
  readonly clear: (threadId: ThreadId) => QueueNotice | null;
  readonly count: (threadId: ThreadId) => number;
  readonly next: (input: {
    readonly messageId: number;
    readonly threadId: ThreadId;
  }) => void;
  readonly peek: (threadId: ThreadId) => QueueNotice | null;
}

/** Builds the status-message state. One per process. */
export const makeQueueNotices = (): QueueNotices => {
  const notices = new Map<ThreadId, QueueNotice>();
  return {
    clear: (threadId) => {
      const held = notices.get(threadId) ?? null;
      notices.delete(threadId);
      return held;
    },
    count: (threadId) => notices.get(threadId)?.waiting ?? 0,
    next: ({ messageId, threadId }) => {
      notices.set(threadId, {
        messageId,
        waiting: (notices.get(threadId)?.waiting ?? 0) + 1,
      });
    },
    peek: (threadId) => notices.get(threadId) ?? null,
  };
};

/** What saying anything into a chat about a thread needs. */
interface NoticeTarget {
  readonly chatId: number;
  readonly notices: QueueNotices;
  readonly threadId: ThreadId;
}

/**
 * Say — or re-say — that this thread is busy.
 *
 * Best effort throughout: a status line the chat refused changes nothing about
 * the message, which is already stored and already queued.
 */
export const noteQueued = Effect.fnUntraced(function* (target: NoticeTarget) {
  const { chatId, notices, threadId } = target;
  const telegram = yield* BotService;
  const held = notices.peek(threadId);

  if (held !== null) {
    notices.next({ messageId: held.messageId, threadId });
    yield* editText({
      api: telegram.api,
      chatId,
      messageId: held.messageId,
      send: { ...HTML, reply_markup: forceSendKeyboard(threadId) },
      text: queuedText(notices.count(threadId)),
    }).pipe(Effect.ignore);
    return;
  }

  const sent = yield* sendText({
    api: telegram.api,
    chatId,
    send: { ...HTML, reply_markup: forceSendKeyboard(threadId) },
    text: queuedText(1),
  }).pipe(Effect.orElseSucceed(() => []));

  const messageId = sent.at(-1)?.message_id;
  if (messageId !== undefined) {
    notices.next({ messageId, threadId });
  }
});

/** Take the status message down, because the turn it was about has ended. */
export const clearQueued = Effect.fnUntraced(function* (target: NoticeTarget) {
  const held = target.notices.clear(target.threadId);
  if (held === null) {
    return;
  }
  const telegram = yield* BotService;
  yield* deleteMessage({
    api: telegram.api,
    chatId: target.chatId,
    messageId: held.messageId,
  });
});

/**
 * Markdown punctuation in a value this module interpolated, defused.
 *
 * Nothing the model wrote goes through here — parsing that is the point. This
 * is for the words the bot puts around it: a run's error class is this system's
 * own text but not a closed set, and a `_` in one would otherwise italicise the
 * rest of the line it lands in.
 */
const escapeMarkdown = (text: string) =>
  text.replace(/[\\`*_~[\]<>|$]/g, (char) => `\\${char}`);

/** Italic, in Markdown. Callers escape what they pass. */
const italicMarkdown = (text: string) => `_${text}_`;

/**
 * The answer as one rich-message body: what the model wrote, as it wrote it,
 * with the turn's economics under it.
 *
 * The body is passed through untouched, because {@link sendRich} sends it to an
 * endpoint that parses Markdown and falls back to plain text on a refusal — the
 * escape this used to do bought safety the fallback now buys, at the cost of
 * showing every reader the asterisks.
 *
 * One dialect throughout: `InputRichMessage` is Markdown or HTML and not both,
 * so the footer is written in Markdown here rather than borrowed from
 * `format.ts`, which speaks the HTML the rest of the bot's chrome speaks. A
 * failed turn still says what class of failure it was — silence after a
 * question is the one ending nobody can act on.
 */
export const answerMarkdown = (input: {
  readonly answer: ChatMessage | null;
  readonly run: Run;
}) => {
  const { answer, run } = input;
  const body =
    answer === null
      ? italicMarkdown(
          `The turn ended ${escapeMarkdown(run.outcome ?? run.status)} without an answer${run.errorClass === null ? "" : ` — ${escapeMarkdown(run.errorClass)}`}.`
        )
      : answer.body;
  const parts = footerParts({
    costUsd: run.costUsd === null ? null : Number(run.costUsd),
    durationMs: run.durationMs,
    totalTokens: run.totalTokens,
    turns: run.turns,
  });
  return parts.length === 0
    ? body
    : `${body}\n\n${italicMarkdown(parts.join(FOOTER_SEPARATOR))}`;
};

/** What the reads behind a delivered answer need. */
export type AnswerServices =
  | BotService
  | ChatMessageRepo
  | ChatThreadRepo
  | RunRepo;

/** How far back the answer to one turn is looked for. */
const ANSWER_LOOKBACK = 10;

/**
 * How long the answer row itself is waited for, once the run has settled.
 *
 * The loop writes the message before it closes the run row, so by the time a
 * run reads as ended its answer is already there — this window is the allowance
 * for a loop that has not been restarted onto that ordering yet, and it is
 * short because the only thing on the other side of it is one insert.
 */
const ANSWER_WINDOW_MS = 2000;

/** The newest thing the manager said on this run, or null if it said nothing. */
const answerIn = (input: {
  readonly messages: readonly ChatMessage[];
  readonly runId: RunId;
}) =>
  [...input.messages]
    .reverse()
    .find((row) => row.role === "manager" && row.runId === input.runId) ?? null;

/**
 * Render one finished manager turn into the conversation it belongs to.
 *
 * Called from the run-event listener when a run with no task reaches a terminal
 * event. Answers with the Telegram message id it sent, or null where there was
 * nothing to say it into — a thread opened from the dashboard has no chat, and
 * that is a thread the dashboard reads rather than a failure.
 *
 * Both reads wait for the close-out rather than racing it. The run is read
 * until it is no longer live, so the economics under the answer are the run's
 * own and not a row still saying `running`; the conversation is then read until
 * the manager's message is in it. A turn that genuinely said nothing costs the
 * second window and is reported as what it was.
 */
export const deliverAnswer = Effect.fn("bot.answer.deliver")(function* (input: {
  readonly keyboards: KeyboardRefresh;
  readonly notices: QueueNotices;
  readonly run: { readonly id: RunId; readonly workspaceId: WorkspaceId };
}) {
  const runs = yield* RunRepo;
  const threads = yield* ChatThreadRepo;
  const messages = yield* ChatMessageRepo;
  const telegram = yield* BotService;

  const run = yield* settledRun({
    runId: input.run.id,
    runs,
    workspaceId: input.run.workspaceId,
  });
  if (run === null) {
    yield* Effect.logWarning("no run row behind a finished turn", {
      runId: input.run.id,
    });
    return null;
  }
  if (run.threadId === null) {
    return null;
  }
  const thread = yield* threads.byId({
    id: run.threadId,
    workspaceId: run.workspaceId,
  });
  if (thread.chatId === null) {
    return null;
  }

  const chatId = Number(thread.chatId);
  yield* clearQueued({ chatId, notices: input.notices, threadId: thread.id });

  const answer = yield* settle({
    read: messages
      .recent({
        limit: ANSWER_LOOKBACK,
        threadId: thread.id,
        workspaceId: thread.workspaceId,
      })
      .pipe(
        Effect.map((recent) => answerIn({ messages: recent, runId: run.id }))
      ),
    settled: (found) => found !== null,
    windowMs: ANSWER_WINDOW_MS,
  });

  // An answer carries no buttons of its own, which makes it the message that
  // hands over a menu this chat has not been shown since the process started.
  const menu = input.keyboards.markupFor(chatId);
  const sent = yield* sendRich({
    api: telegram.api,
    chatId,
    markdown: answerMarkdown({ answer, run }),
    send: menu === undefined ? {} : { reply_markup: menu },
  }).pipe(Effect.orElseSucceed(() => []));

  return sent.at(-1)?.message_id ?? null;
});
