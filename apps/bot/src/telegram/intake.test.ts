/**
 * Classification is the one part of intake with no I/O in it, and it is where
 * the mistakes are cheapest to make: an album counted as a photo, a forwarded
 * voice note counted as a forward, a caption dropped because it was not
 * `text`. Each test below is one of those confusions, pinned.
 *
 * The resolve tests exist for a different reason: to hold the rule that
 * `transcriptChars` and `transcribeMs` are non-null for a voice note and null
 * for everything else. A fabricated zero on a text message is what makes an
 * average over the ledger a lie.
 */

import { describe, expect, test } from "bun:test";
import { Effect, Layer, Redacted } from "effect";
import { TranscribeService } from "../transcribe";
import type { FileLocator } from "./download";
import {
  classifyMessage,
  forwardSenderName,
  isIntakeMessage,
  refusalFor,
  resolveIntake,
  type TelegramMessage,
  UNSUPPORTED_INTAKE_REASONS,
} from "./intake";

const CHAT_ID = 4242;
const MESSAGE_ID = 7;

/** A message with only the fields a branch reads. The rest never reaches the classifier. */
const messageOf = (fields: Partial<TelegramMessage>) =>
  ({
    chat: { id: CHAT_ID, type: "private" },
    date: 0,
    message_id: MESSAGE_ID,
    ...fields,
  }) as TelegramMessage;

const userOrigin = {
  date: 0,
  sender_user: { first_name: "Ada", id: 1, is_bot: false },
  type: "user",
} as NonNullable<TelegramMessage["forward_origin"]>;

describe("classifyMessage", () => {
  test("plain text carries its body, its length and its message id", () => {
    const result = classifyMessage(messageOf({ text: "file a task" }));
    expect(result).toEqual({
      body: "file a task",
      chars: 11,
      forwardFrom: null,
      kind: "text",
      telegramChatId: CHAT_ID,
      telegramMessageId: MESSAGE_ID,
    });
  });

  test("a forward is its own kind and names the sender, without prefixing the body", () => {
    const result = classifyMessage(
      messageOf({ forward_origin: userOrigin, text: "look at this" })
    );
    expect(result).toEqual({
      body: "look at this",
      chars: 12,
      forwardFrom: "Ada",
      kind: "forward",
      telegramChatId: CHAT_ID,
      telegramMessageId: MESSAGE_ID,
    });
  });

  test("a forwarded rich message from a bot is a forward, not an attachment", () => {
    // The reported bug, as Telegram delivers it: a bot answered with
    // `sendRichMessage`, so the message carries no `text` and no `caption` and
    // every word is in `rich_message`. Read only `text` and this is refused
    // with "I can only work with text and voice messages."
    const result = classifyMessage(
      messageOf({
        forward_origin: {
          date: 0,
          sender_user: { first_name: "Codex", id: 777, is_bot: true },
          type: "user",
        } as NonNullable<TelegramMessage["forward_origin"]>,
        rich_message: {
          blocks: [
            { size: 2, text: "Fresh batch", type: "heading" },
            {
              text: [
                "grouped by the ",
                { text: "viral mechanic", type: "bold" },
              ],
              type: "paragraph",
            },
          ],
        } as NonNullable<TelegramMessage["rich_message"]>,
      })
    );
    expect(result).toEqual({
      body: "## Fresh batch\n\ngrouped by the viral mechanic",
      chars: 45,
      forwardFrom: "Codex",
      kind: "forward",
      telegramChatId: CHAT_ID,
      telegramMessageId: MESSAGE_ID,
    });
  });

  test("a rich message sent straight into the chat is ordinary text", () => {
    const result = classifyMessage(
      messageOf({
        rich_message: {
          blocks: [{ text: "file a task", type: "paragraph" }],
        } as NonNullable<TelegramMessage["rich_message"]>,
      })
    );
    expect(result).toMatchObject({ body: "file a task", kind: "text" });
  });

  test("a rich message with nothing to read is empty, not unsupported", () => {
    expect(
      classifyMessage(
        messageOf({
          // A rich message of one uncaptioned photo: blocks, but no words.
          rich_message: {
            blocks: [
              {
                photo: [
                  { file_id: "p", file_unique_id: "u", height: 1, width: 1 },
                ],
                type: "photo",
              },
            ],
          } as NonNullable<TelegramMessage["rich_message"]>,
        })
      )
    ).toMatchObject({ reason: "empty" });
  });

  test("a refusal records what the message was made of, never its content", () => {
    const result = classifyMessage(
      messageOf({
        forward_origin: userOrigin,
        sticker: {
          file_id: "s",
          file_unique_id: "u",
          height: 512,
          is_animated: false,
          is_video: false,
          type: "regular",
          width: 512,
        } as NonNullable<TelegramMessage["sticker"]>,
      })
    );
    expect(result).toMatchObject({
      reason: "unsupported_media",
      shape: "forward_origin,sticker",
    });
  });

  test("a caption is a body — a forwarded caption is not dropped", () => {
    const result = classifyMessage(
      messageOf({ caption: "from the channel", forward_origin: userOrigin })
    );
    expect(result).toMatchObject({ body: "from the channel", kind: "forward" });
  });

  test("a voice note carries no body and no character count", () => {
    const result = classifyMessage(
      messageOf({
        voice: { duration: 12, file_id: "AgAD", file_unique_id: "u" },
      })
    );
    expect(result).toEqual({
      fileId: "AgAD",
      forwardFrom: null,
      kind: "voice",
      telegramChatId: CHAT_ID,
      telegramMessageId: MESSAGE_ID,
      voiceSeconds: 12,
    });
  });

  test("a forwarded voice note is a voice note that remembers the sender", () => {
    const result = classifyMessage(
      messageOf({
        forward_origin: userOrigin,
        voice: { duration: 3, file_id: "AgAD", file_unique_id: "u" },
      })
    );
    expect(result).toMatchObject({ forwardFrom: "Ada", kind: "voice" });
  });

  test("an album is refused as a group, before its photos are refused one by one", () => {
    const result = classifyMessage(
      messageOf({
        media_group_id: "999",
        photo: [{ file_id: "p", file_unique_id: "u", height: 1, width: 1 }],
      })
    );
    expect(result).toMatchObject({
      kind: "unsupported",
      reason: "media_group",
    });
  });

  test("photos, documents and anything else are refused with their own reason", () => {
    expect(
      classifyMessage(
        messageOf({
          photo: [{ file_id: "p", file_unique_id: "u", height: 1, width: 1 }],
        })
      )
    ).toMatchObject({ reason: "photo" });
    expect(
      classifyMessage(
        messageOf({ document: { file_id: "d", file_unique_id: "u" } })
      )
    ).toMatchObject({ reason: "document" });
    expect(classifyMessage(messageOf({}))).toMatchObject({
      reason: "unsupported_media",
    });
    expect(classifyMessage(messageOf({ text: "" }))).toMatchObject({
      reason: "empty",
    });
  });

  test("every refusal reason has a sentence of its own", () => {
    const sentences = UNSUPPORTED_INTAKE_REASONS.map(refusalFor);
    expect(new Set(sentences).size).toBe(UNSUPPORTED_INTAKE_REASONS.length);
  });

  test("isIntakeMessage separates the turns from the refusals", () => {
    expect(isIntakeMessage(classifyMessage(messageOf({ text: "hi" })))).toBe(
      true
    );
    expect(isIntakeMessage(classifyMessage(messageOf({})))).toBe(false);
  });
});

describe("forwardSenderName", () => {
  test("names a user, a channel and a hidden sender, and refuses to guess otherwise", () => {
    expect(forwardSenderName(userOrigin)).toBe("Ada");
    expect(
      forwardSenderName({
        chat: { id: -1, title: "Releases", type: "channel" },
        date: 0,
        message_id: 1,
        type: "channel",
      } as NonNullable<TelegramMessage["forward_origin"]>)
    ).toBe("Releases");
    expect(
      forwardSenderName({
        date: 0,
        sender_user_name: "Someone",
        type: "hidden_user",
      } as NonNullable<TelegramMessage["forward_origin"]>)
    ).toBe("Someone");
    expect(
      forwardSenderName({ type: "chat" } as NonNullable<
        TelegramMessage["forward_origin"]
      >)
    ).toBe("unknown");
  });
});

const silentTranscriber = Layer.succeed(TranscribeService, {
  available: true,
  transcribe: () =>
    Effect.succeed({ chars: 9, durationMs: 1234, text: "spoken it" }),
} as unknown as TranscribeService["Service"]);

const locator: FileLocator = {
  getFile: () => Promise.resolve({ file_path: "voice/file_1.oga" }),
};

const token = Redacted.make("123456:aaaaaaaaaaaaaaaaaaaaaaaaaaaa");

describe("resolveIntake", () => {
  test("a text turn has null transcription measurements, not zeros", async () => {
    const resolved = await Effect.runPromise(
      resolveIntake({
        api: locator,
        message: {
          body: "file a task",
          chars: 11,
          forwardFrom: null,
          kind: "text",
          telegramChatId: CHAT_ID,
          telegramMessageId: MESSAGE_ID,
        },
        token,
      }).pipe(Effect.provide(silentTranscriber))
    );
    expect(resolved).toEqual({
      body: "file a task",
      chars: 11,
      forwardFrom: null,
      intakeKind: "text",
      telegramChatId: CHAT_ID,
      telegramMessageId: MESSAGE_ID,
      transcribeMs: null,
      transcriptChars: null,
    });
  });

  test("a voice turn resolves to the transcript, its length and how long it took", async () => {
    const realFetch = globalThis.fetch;
    globalThis.fetch = (() =>
      Promise.resolve(
        new Response(new Uint8Array([1, 2, 3]))
      )) as unknown as typeof globalThis.fetch;

    try {
      const resolved = await Effect.runPromise(
        resolveIntake({
          api: locator,
          message: {
            fileId: "AgAD",
            forwardFrom: "Ada",
            kind: "voice",
            telegramChatId: CHAT_ID,
            telegramMessageId: MESSAGE_ID,
            voiceSeconds: 3,
          },
          token,
        }).pipe(Effect.provide(silentTranscriber))
      );
      expect(resolved).toEqual({
        body: "spoken it",
        chars: 9,
        forwardFrom: "Ada",
        intakeKind: "voice",
        telegramChatId: CHAT_ID,
        telegramMessageId: MESSAGE_ID,
        transcribeMs: 1234,
        transcriptChars: 9,
      });
    } finally {
      globalThis.fetch = realFetch;
    }
  });
});
