/**
 * A Telegram API that answers instead of sending.
 *
 * The seam is grammy's own transformer, installed on a real `Bot`'s `api`, so
 * what a test drives is the client the app uses — payload shaping, the HTML it
 * composes, the message id it reads back — with nothing leaving the machine.
 * `scripts/bot-check.ts` does the same thing against a real database; this is
 * the same idea sized for a unit test.
 *
 * Refusals are part of the seam rather than an afterthought: a chat that
 * refuses an edit is the ordinary case behind every fallback path in the send
 * helpers, and a fake that can only succeed cannot exercise one.
 */

import { Bot, type Transformer } from "grammy";
import type { BotContext } from "../telegram/context";

/** A token shaped like a real one and belonging to nobody. */
const FAKE_TOKEN = "900000001:AAHtesttesttesttesttesttesttesttest";

/** The first message id a recorded send answers with. */
const FIRST_MESSAGE_ID = 1000;

/** One Telegram call this fake intercepted. */
export interface ApiCall {
  readonly method: string;
  readonly payload: Record<string, unknown>;
}

/** What a recording API hands back: the client, and everything asked of it. */
export interface RecordingApi {
  readonly api: Bot<BotContext>["api"];
  readonly calls: ApiCall[];
}

/**
 * A Telegram client that records every call and answers it locally.
 *
 * `refuse` names the methods that come back as a Telegram error rather than a
 * result — grammy turns those into a `GrammyError`, which is what the app's own
 * error mapping expects.
 */
export const recordingApi = (
  options: { readonly refuse?: readonly string[] } = {}
): RecordingApi => {
  const calls: ApiCall[] = [];
  const refuse = options.refuse ?? [];
  let nextMessageId = FIRST_MESSAGE_ID;

  const transformer = ((
    _next: unknown,
    method: string,
    payload: Record<string, unknown>
  ) => {
    calls.push({ method, payload });
    if (refuse.includes(method)) {
      return Promise.resolve({
        description: `Bad Request: ${method} refused`,
        error_code: 400,
        ok: false,
      });
    }
    if (method === "sendMessage" || method === "editMessageText") {
      nextMessageId += 1;
      return Promise.resolve({
        ok: true,
        result: {
          chat: { id: Number(payload.chat_id ?? 0), type: "private" },
          date: 0,
          message_id: nextMessageId,
          text: String(payload.text ?? ""),
        },
      });
    }
    if (method === "sendRichMessage") {
      nextMessageId += 1;
      return Promise.resolve({
        ok: true,
        result: {
          chat: { id: Number(payload.chat_id ?? 0), type: "private" },
          date: 0,
          message_id: nextMessageId,
          // A rich message carries no `text` and no `caption`: its words live
          // in a block tree Telegram parsed. This fake does not parse, so the
          // tree is empty and what a test reads is the payload it was sent.
          rich_message: { blocks: [] },
        },
      });
    }
    return Promise.resolve({ ok: true, result: true });
  }) as unknown as Transformer;

  const bot = new Bot<BotContext>(FAKE_TOKEN);
  bot.api.config.use(transformer);
  return { api: bot.api, calls };
};

/** The last call to one method, or null if it was never made. */
export const lastCallOf = (input: {
  readonly calls: readonly ApiCall[];
  readonly method: string;
}) => [...input.calls].reverse().find((c) => c.method === input.method) ?? null;

/** The text of the last call to one method, or null if it was never made. */
export const lastTextOf = (input: {
  readonly calls: readonly ApiCall[];
  readonly method: string;
}) => {
  const call = lastCallOf(input);
  return call === null ? null : String(call.payload.text ?? "");
};

/**
 * The Markdown of the last rich message sent, or null if none was.
 *
 * A rich send puts its words in `rich_message`, so this is the `lastTextOf` of
 * that path — the one place a test looks to see what a person would read.
 */
export const lastRichMarkdownOf = (input: {
  readonly calls: readonly ApiCall[];
}) => {
  const call = lastCallOf({ calls: input.calls, method: "sendRichMessage" });
  if (call === null) {
    return null;
  }
  const rich = call.payload.rich_message as { markdown?: string } | undefined;
  return rich?.markdown ?? null;
};

/** Every rich message sent, in order, as the Markdown each carried. */
export const richMarkdownsOf = (input: {
  readonly calls: readonly ApiCall[];
}) =>
  input.calls
    .filter((call) => call.method === "sendRichMessage")
    .map(
      (call) =>
        (call.payload.rich_message as { markdown?: string } | undefined)
          ?.markdown ?? ""
    );
