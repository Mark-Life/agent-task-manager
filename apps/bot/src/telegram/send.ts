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
 *
 * There are two ways out of here, one per dialect. {@link sendText} is the
 * bot's own chrome: Telegram HTML, every interpolated value escaped by
 * `format.ts` on the way in. {@link sendRich} is for text a model wrote, which
 * is Markdown and is meant to be read as Markdown — it goes to
 * `sendRichMessage`, which parses server-side, and falls back to a plain send
 * of the same words when Telegram refuses it.
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
 * The two options both send paths carry, and the only two `sendRichMessage`
 * shares with `sendMessage` that this bot uses. Derived rather than restated,
 * so a keyboard type that changes upstream changes here.
 */
export interface ChunkedSendOptions {
  readonly reply_markup?: SendMessageOptions["reply_markup"];
  readonly reply_parameters?: SendMessageOptions["reply_parameters"];
}

/** Where in a piece of text the next cut goes, newline preferred. */
const cutPoint = (options: {
  readonly maxLength: number;
  readonly text: string;
}) => {
  const { maxLength, text } = options;
  const newline = text.lastIndexOf("\n", maxLength);
  return newline > maxLength * MIN_CUT_FRACTION ? newline : maxLength;
};

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
    const cut = cutPoint({ maxLength, text: remaining });
    chunks.push(remaining.slice(0, cut));
    remaining = remaining.slice(cut);
  }
  if (remaining.length > 0) {
    chunks.push(remaining);
  }
  return chunks;
};

/** A line that opens or closes a fenced code block, in either of GFM's markers. */
const FENCE_LINE = /^ {0,3}(`{3,}|~{3,})(.*)$/;

/** A code fence still open at the end of a piece of Markdown. */
interface OpenFence {
  /** The run of backticks or tildes that has to close it. */
  readonly marker: string;
  /** The line that opened it, reopened verbatim above the next chunk. */
  readonly opener: string;
}

/**
 * The fence left open at the end of some Markdown, or null if none is.
 *
 * A closer repeats the opener's character, at least as many times, and says
 * nothing else on the line — which is also why the opener is remembered whole:
 * it carries the language, and a reopened block that lost its `ts` is a block
 * that stops being syntax-highlighted halfway down.
 */
const openFenceIn = (text: string): OpenFence | null => {
  let open: OpenFence | null = null;
  for (const line of text.split("\n")) {
    const match = FENCE_LINE.exec(line);
    if (match === null) {
      continue;
    }
    const marker = match[1] ?? "";
    const rest = match[2] ?? "";
    if (open === null) {
      open = { marker, opener: line.trimEnd() };
      continue;
    }
    if (
      marker[0] === open.marker[0] &&
      marker.length >= open.marker.length &&
      rest.trim().length === 0
    ) {
      open = null;
    }
  }
  return open;
};

/**
 * Room every chunk keeps back for the fence it may have to close.
 *
 * The longest marker in the whole body plus its newline, computed once: it is
 * an upper bound on what closing costs, so a chunk that turns out to end inside
 * a block can always afford to close it and still fit. Markdown with no fences
 * in it reserves nothing and splits exactly like plain text.
 */
const closeReserve = (text: string) => {
  let longest = 0;
  for (const line of text.split("\n")) {
    const marker = FENCE_LINE.exec(line)?.[1];
    if (marker !== undefined) {
      longest = Math.max(longest, marker.length);
    }
  }
  return longest === 0 ? 0 : longest + 1;
};

/**
 * Split Markdown into pieces that each fit a Telegram message and each parse on
 * their own.
 *
 * Same cut rule as {@link splitText}, plus the one thing a cut can break that a
 * plain split does not care about: a code fence. A chunk that ends inside a
 * block closes it, and the next chunk reopens it with the same opener line, so
 * neither half renders as prose — an unterminated fence is not a visible bug, it
 * is a code block silently read as paragraphs.
 *
 * Nothing is dropped: every character of the input appears, in order, in exactly
 * one chunk. What is added is the fence pair, and — only where a cut landed
 * mid-line inside a block, which needs a newline the opener line cannot do
 * without — one line break in the middle of one line of code.
 */
export const splitMarkdown = (options: {
  readonly maxLength?: number;
  readonly text: string;
}) => {
  const maxLength = Math.max(1, options.maxLength ?? DEFAULT_SPLIT_AT);
  const reserve = closeReserve(options.text);
  const chunks: string[] = [];
  let remaining = options.text;
  let open: OpenFence | null = null;

  while (remaining.length > 0) {
    // The cut lands on a newline where it can, so a reopened block usually
    // already has the line break the opener needs.
    const reopen =
      open === null
        ? ""
        : `${open.opener}${remaining.startsWith("\n") ? "" : "\n"}`;
    if (reopen.length + remaining.length <= maxLength) {
      chunks.push(reopen + remaining);
      break;
    }
    const room = Math.max(1, maxLength - reopen.length - reserve);
    const body = remaining.slice(
      0,
      cutPoint({ maxLength: room, text: remaining })
    );
    const ending = openFenceIn(reopen + body);
    const closer =
      ending === null
        ? ""
        : `${body.endsWith("\n") ? "" : "\n"}${ending.marker}`;
    chunks.push(reopen + body + closer);
    remaining = remaining.slice(body.length);
    open = ending;
  }
  return chunks.length === 0 ? [options.text] : chunks;
};

/**
 * The per-chunk options for a split send: the reply link on the first, the
 * keyboard on the last, everything else on all of them.
 */
const chunkOptions = <O extends ChunkedSendOptions>(options: {
  readonly index: number;
  readonly send: O;
  readonly total: number;
}) => {
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

/** What a rich send answers with, whichever of the two paths delivered it. */
type SentMessage =
  | Awaited<ReturnType<Api["sendMessage"]>>
  | Awaited<ReturnType<Api["sendRichMessage"]>>;

/**
 * Send Markdown a model wrote to a chat, as a rich message, splitting it across
 * as many messages as it needs.
 *
 * The Markdown is passed through raw: `sendRichMessage` parses it server-side,
 * which is the whole point — `**bold**` arrives bold rather than as four
 * asterisks. What makes that safe is the fallback. Telegram answers markup it
 * cannot parse with a 400, and an answer nobody sees is the one failure worth
 * engineering against, so a refused chunk is re-sent with `sendMessage` and no
 * parse mode at all: the words arrive intact, with the markup showing as the
 * source the model typed. That is the rendering this bot had before rich
 * messages, kept as the floor rather than as the ceiling.
 *
 * The fallback disables the link preview because it is a bare-text last resort
 * and a preview card under it is noise; the rich path has no such parameter,
 * Telegram laying out the document's links itself.
 *
 * Sequential for the same reason {@link sendText} is: a split answer that
 * arrives out of order is worse than a slow one.
 */
export const sendRich = Effect.fn("Telegram.sendRich")(function* (options: {
  readonly api: Api;
  readonly chatId: number;
  readonly markdown: string;
  readonly send?: ChunkedSendOptions;
  readonly splitAt?: number;
}) {
  const { api, chatId, markdown, send = {}, splitAt } = options;
  const chunks = splitMarkdown({ maxLength: splitAt, text: markdown });
  const sent: SentMessage[] = [];
  for (const [index, chunk] of chunks.entries()) {
    const per = chunkOptions({ index, send, total: chunks.length });
    const message = yield* Effect.tryPromise({
      catch: (cause) =>
        toTelegramApiError({ cause, method: "sendRichMessage" }),
      try: () => api.sendRichMessage(chatId, { markdown: chunk }, per),
    }).pipe(
      Effect.catch((error) =>
        Effect.logWarning("rich message refused, sending it as plain text", {
          description: error.description,
          errorCode: error.errorCode,
        }).pipe(
          Effect.andThen(
            Effect.tryPromise({
              catch: (cause) =>
                toTelegramApiError({ cause, method: "sendMessage" }),
              try: () =>
                api.sendMessage(chatId, chunk, {
                  ...per,
                  link_preview_options: { is_disabled: true },
                }),
            })
          )
        )
      )
    );
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
