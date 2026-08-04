/**
 * What a person sees while their voice note is being heard, and what they see
 * afterwards: the words the bot took down.
 *
 * A voice note is the one intake where the sender cannot check what was
 * received. Text is on screen already; a transcript exists only inside this
 * process, goes into the prompt and the `chat_message` row, and — until this
 * module — never came back. A misheard sentence then reads as a manager that
 * answered something nobody asked. So the transcript is echoed into the chat as
 * a quote, which is the pattern the `telegram-claude` bot settled on and the
 * one ported here: a status line first, replying to the voice note so the two
 * sit together, edited into the transcript when the words arrive.
 *
 * Editing rather than sending a second message is deliberate — the placeholder
 * is scaffolding, not a message worth keeping — but it is also not load
 * bearing: {@link echoTranscript} sends the transcript as its own message when
 * there is no placeholder to edit or the edit is refused. Every path in here
 * ends with the words in the chat or with a sentence saying why they are not.
 *
 * The quote is escaped, never parsed. A transcript is somebody's speech and a
 * `<` in it is not markup.
 */

import { Effect } from "effect";
import type { Api } from "grammy";
import { blockquote, italic } from "./format";
import { editText, sendText } from "./send";

/** How Telegram is told to parse everything this module composes. */
const HTML = { parse_mode: "HTML" } as const;

/** The line that stands in the chat while Groq is listening. */
export const TRANSCRIBING_TEXT = "Transcribing…";

/**
 * How much of a transcript is echoed back.
 *
 * Under Telegram's 4096-character message cap with room for the quote tags and
 * the note, because the echo is one message that is edited into place and an
 * edit cannot be split across two.
 */
export const TRANSCRIPT_ECHO_MAX_CHARS = 3800;

/** Appended when the echo was cut, so nobody reads a clipped quote as all of it. */
const TRUNCATION_NOTE = "… (truncated)";

/** What a voice note that turned out to hold no words gets back. */
export const EMPTY_TRANSCRIPT_TEXT = "I could not make out any words in that.";

/** What a voice note nobody could transcribe gets back. */
export const TRANSCRIPT_FAILED_TEXT =
  "I could not transcribe that voice note — send it as text instead.";

/**
 * The transcript as one message body: the words, quoted and escaped, clipped
 * with the cut stated rather than implied.
 */
export const transcriptText = (text: string) => {
  const trimmed = text.trim();
  if (trimmed.length === 0) {
    return italic(EMPTY_TRANSCRIPT_TEXT);
  }
  const clipped =
    trimmed.length > TRANSCRIPT_ECHO_MAX_CHARS
      ? trimmed.slice(0, TRANSCRIPT_ECHO_MAX_CHARS) + TRUNCATION_NOTE
      : trimmed;
  return blockquote({ text: clipped });
};

/** Where an echo is going, and which of the chat's messages it belongs under. */
interface EchoTarget {
  readonly api: Api;
  readonly chatId: number;
}

/**
 * Put the "Transcribing…" line in the chat, as a reply to the voice note.
 *
 * Answers the message id to edit later, or null when the line could not be
 * sent — a chat that refused it is a chat the transcript will be sent into
 * whole instead, and never a reason to fail the message it was about.
 */
export const openTranscriptNotice = Effect.fn("bot.voice.notice")(function* (
  input: EchoTarget & { readonly replyToMessageId: number }
) {
  const sent = yield* sendText({
    api: input.api,
    chatId: input.chatId,
    send: {
      ...HTML,
      reply_parameters: { message_id: input.replyToMessageId },
    },
    text: italic(TRANSCRIBING_TEXT),
  }).pipe(Effect.orElseSucceed(() => []));
  return sent.at(-1)?.message_id ?? null;
});

/**
 * Show the words, in the placeholder where there is one and in a message of
 * their own where there is not.
 *
 * Best effort at the end: an echo the chat refused twice changes nothing about
 * the message, which is already stored and already on its way to the manager.
 */
export const echoTranscript = Effect.fn("bot.voice.echo")(function* (
  input: EchoTarget & {
    readonly noticeId: number | null;
    readonly text: string;
  }
) {
  const body = transcriptText(input.text);
  if (input.noticeId !== null) {
    const edited = yield* editText({
      api: input.api,
      chatId: input.chatId,
      messageId: input.noticeId,
      send: HTML,
      text: body,
    }).pipe(Effect.option);
    if (edited._tag === "Some") {
      return;
    }
  }
  yield* sendText({
    api: input.api,
    chatId: input.chatId,
    send: HTML,
    text: body,
  }).pipe(Effect.ignore);
});

/**
 * Say that the voice note could not be heard, in the same place the transcript
 * would have gone.
 */
export const echoTranscriptFailure = (
  input: EchoTarget & { readonly noticeId: number | null }
) =>
  input.noticeId === null
    ? sendText({
        api: input.api,
        chatId: input.chatId,
        send: HTML,
        text: italic(TRANSCRIPT_FAILED_TEXT),
      }).pipe(Effect.asVoid, Effect.ignore)
    : editText({
        api: input.api,
        chatId: input.chatId,
        messageId: input.noticeId,
        send: HTML,
        text: italic(TRANSCRIPT_FAILED_TEXT),
      }).pipe(Effect.asVoid, Effect.ignore);
