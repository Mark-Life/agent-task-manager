/**
 * Getting text out of this process and into a chat, in one piece or in several.
 *
 * Telegram caps a message at 4096 characters and answers a longer one with a
 * 400. Anything this bot sends can exceed that — a board listing, a manager's
 * answer, a transcript — so nothing calls `sendMessage` directly; it calls
 * {@link sendText}, which splits first.
 *
 * Where the split lands is the whole design. Cutting at exactly the limit puts
 * a break in the middle of a word, a code fence or a URL, so the cut walks back
 * to the last newline — but only if that newline is past the halfway mark.
 * Otherwise a single long paragraph would produce a stream of tiny chunks, one
 * per stray early newline. Past halfway means every chunk is at least half full
 * and the number of messages stays bounded by the length of the text.
 *
 * The split is lossless: the chunks concatenate back to the original, newline
 * and all. A splitter that swallows the separator is a splitter that silently
 * edits what a model said.
 *
 * Two decisions about multi-chunk sends are made here rather than at each call
 * site: only the first chunk replies to the incoming message, and only the last
 * one carries the keyboard. A reply arrow on every chunk is noise, and buttons
 * halfway up a wall of text are buttons nobody finds.
 */

import { Effect } from "effect";
import type { Api } from "grammy";
import { toTelegramApiError } from "./errors";

/** Telegram's own hard cap on a text message. */
export const TELEGRAM_MAX_MESSAGE_CHARS = 4096;

/**
 * Where this bot splits by default, under the protocol cap.
 *
 * The headroom is for what a caller appends after the split decision: a footer,
 * an ellipsis, an HTML tag pair reopened across the boundary.
 */
export const DEFAULT_SPLIT_AT = 4000;

/** Fraction of the budget a newline must be past to be worth cutting at. */
const MIN_CUT_FRACTION = 0.5;

/** Everything `sendMessage` accepts beyond the text, derived so it cannot drift. */
export type SendMessageOptions = NonNullable<Parameters<Api["sendMessage"]>[2]>;

/**
 * Split text into pieces that each fit a Telegram message, preferring newline
 * boundaries. The pieces concatenate back to the input exactly.
 */
export const splitText = (options: {
  readonly maxLength?: number;
  readonly text: string;
}) => {
  const maxLength = Math.max(1, options.maxLength ?? DEFAULT_SPLIT_AT);
  if (options.text.length <= maxLength) {
    return [options.text];
  }
  const chunks: string[] = [];
  let remaining = options.text;
  while (remaining.length > maxLength) {
    const newline = remaining.lastIndexOf("\n", maxLength);
    const cut = newline > maxLength * MIN_CUT_FRACTION ? newline : maxLength;
    chunks.push(remaining.slice(0, cut));
    remaining = remaining.slice(cut);
  }
  if (remaining.length > 0) {
    chunks.push(remaining);
  }
  return chunks;
};

/**
 * The per-chunk options for a split send: the reply link on the first, the
 * keyboard on the last, everything else on all of them.
 */
const chunkOptions = (options: {
  readonly index: number;
  readonly send: SendMessageOptions;
  readonly total: number;
}): SendMessageOptions => {
  const { index, send, total } = options;
  const { reply_markup, reply_parameters, ...rest } = send;
  return {
    ...rest,
    ...(index === total - 1 && reply_markup !== undefined
      ? { reply_markup }
      : {}),
    ...(index === 0 && reply_parameters !== undefined
      ? { reply_parameters }
      : {}),
  };
};

/**
 * Send text to a chat, splitting it across as many messages as it needs.
 *
 * Sequential on purpose: Telegram delivers concurrent sends to one chat in
 * whatever order they arrive, and a split answer that arrives out of order is
 * worse than a slow one.
 */
export const sendText = Effect.fn("Telegram.sendText")(function* (options: {
  readonly api: Api;
  readonly chatId: number;
  readonly send?: SendMessageOptions;
  readonly splitAt?: number;
  readonly text: string;
}) {
  const { api, chatId, send = {}, splitAt, text } = options;
  const chunks = splitText({ maxLength: splitAt, text });
  const sent: Awaited<ReturnType<Api["sendMessage"]>>[] = [];
  for (const [index, chunk] of chunks.entries()) {
    const message = yield* Effect.tryPromise({
      catch: (cause) => toTelegramApiError({ cause, method: "sendMessage" }),
      try: () =>
        api.sendMessage(
          chatId,
          chunk,
          chunkOptions({ index, send, total: chunks.length })
        ),
    });
    sent.push(message);
  }
  return sent;
});

/**
 * Replace the text of a message already in the chat.
 *
 * Telegram answers an edit that changes nothing with a 400 whose description is
 * `message is not modified`. That is not a failure of anything — it means the
 * draft renderer flushed the same text twice — so it is folded into success
 * rather than raised.
 */
export const editText = Effect.fn("Telegram.editText")(function* (options: {
  readonly api: Api;
  readonly chatId: number;
  readonly messageId: number;
  readonly send?: Parameters<Api["editMessageText"]>[3];
  readonly text: string;
}) {
  const { api, chatId, messageId, send, text } = options;
  return yield* Effect.tryPromise({
    catch: (cause) => toTelegramApiError({ cause, method: "editMessageText" }),
    try: () => api.editMessageText(chatId, messageId, text, send),
  }).pipe(
    Effect.catchIf(
      (error) => error.description.includes("message is not modified"),
      () => Effect.succeed(true as const)
    )
  );
});

/**
 * Delete a message, tolerating the one failure that is not a failure: a message
 * already gone, which is the ordinary outcome of two cleanup paths racing.
 */
export const deleteMessage = Effect.fn("Telegram.deleteMessage")(
  function* (options: {
    readonly api: Api;
    readonly chatId: number;
    readonly messageId: number;
  }) {
    const { api, chatId, messageId } = options;
    yield* Effect.tryPromise({
      catch: (cause) => toTelegramApiError({ cause, method: "deleteMessage" }),
      try: () => api.deleteMessage(chatId, messageId),
    }).pipe(Effect.ignore);
  }
);
