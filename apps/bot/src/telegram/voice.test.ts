/**
 * The claim under these tests is the one the chat makes visible: a voice note
 * comes back as the words that were heard, in the message that said it was
 * listening, whatever Telegram does about the edit.
 *
 * The transcript is somebody's speech, so the escaping tests are not
 * decoration: an unescaped `<` in a quote is a message Telegram refuses with
 * `can't parse entities`, and a refused echo is a sender who never finds out
 * what was taken down.
 */

import { describe, expect, test } from "bun:test";
import { Effect } from "effect";
import { lastTextOf, recordingApi } from "../testing/telegram";
import {
  EMPTY_TRANSCRIPT_TEXT,
  echoTranscript,
  echoTranscriptFailure,
  openTranscriptNotice,
  TRANSCRIBING_TEXT,
  TRANSCRIPT_ECHO_MAX_CHARS,
  TRANSCRIPT_FAILED_TEXT,
  transcriptText,
} from "./voice";

const CHAT_ID = 4242;
const VOICE_MESSAGE_ID = 17;
const NOTICE_ID = 99;

describe("transcriptText", () => {
  test("the words come back quoted", () => {
    expect(transcriptText("test, test, one, two, three")).toBe(
      "<blockquote>test, test, one, two, three</blockquote>"
    );
  });

  test("what was said is escaped, never parsed", () => {
    expect(transcriptText("use <Thing> & go")).toContain(
      "&lt;Thing&gt; &amp; go"
    );
  });

  test("a long transcript is cut, and says that it was", () => {
    const rendered = transcriptText(
      "a".repeat(TRANSCRIPT_ECHO_MAX_CHARS + 500)
    );

    expect(rendered).toContain("truncated");
    // Under Telegram's 4096-character cap, tags and note included.
    expect(rendered.length).toBeLessThan(4096);
  });

  test("a voice note with no words in it says so instead of quoting nothing", () => {
    expect(transcriptText("   ")).toContain(EMPTY_TRANSCRIPT_TEXT);
    expect(transcriptText("   ")).not.toContain("blockquote");
  });
});

describe("openTranscriptNotice", () => {
  test("the line stands under the voice note it is about", async () => {
    const telegram = recordingApi();

    const noticeId = await Effect.runPromise(
      openTranscriptNotice({
        api: telegram.api,
        chatId: CHAT_ID,
        replyToMessageId: VOICE_MESSAGE_ID,
      })
    );

    const sent = telegram.calls.find((call) => call.method === "sendMessage");
    expect(String(sent?.payload.text)).toContain(TRANSCRIBING_TEXT);
    expect(sent?.payload.reply_parameters).toEqual({
      message_id: VOICE_MESSAGE_ID,
    });
    expect(noticeId).not.toBeNull();
  });

  test("a chat that refused the line leaves nothing to edit, and no failure", async () => {
    const telegram = recordingApi({ refuse: ["sendMessage"] });

    const noticeId = await Effect.runPromise(
      openTranscriptNotice({
        api: telegram.api,
        chatId: CHAT_ID,
        replyToMessageId: VOICE_MESSAGE_ID,
      })
    );

    expect(noticeId).toBeNull();
  });
});

describe("echoTranscript", () => {
  test("the transcript replaces the line that said it was listening", async () => {
    const telegram = recordingApi();

    await Effect.runPromise(
      echoTranscript({
        api: telegram.api,
        chatId: CHAT_ID,
        noticeId: NOTICE_ID,
        text: "test, test, one, two, three",
      })
    );

    const edited = telegram.calls.find(
      (call) => call.method === "editMessageText"
    );
    expect(edited?.payload.message_id).toBe(NOTICE_ID);
    expect(String(edited?.payload.text)).toContain(
      "test, test, one, two, three"
    );
    expect(
      telegram.calls.some((call) => call.method === "sendMessage")
    ).toBeFalse();
  });

  test("with no line to edit, the transcript is a message of its own", async () => {
    const telegram = recordingApi();

    await Effect.runPromise(
      echoTranscript({
        api: telegram.api,
        chatId: CHAT_ID,
        noticeId: null,
        text: "one, two, three",
      })
    );

    expect(lastTextOf({ calls: telegram.calls, method: "sendMessage" })).toBe(
      "<blockquote>one, two, three</blockquote>"
    );
  });

  test("an edit the chat refused still leaves the words in the chat", async () => {
    const telegram = recordingApi({ refuse: ["editMessageText"] });

    await Effect.runPromise(
      echoTranscript({
        api: telegram.api,
        chatId: CHAT_ID,
        noticeId: NOTICE_ID,
        text: "one, two, three",
      })
    );

    expect(
      String(lastTextOf({ calls: telegram.calls, method: "sendMessage" }))
    ).toContain("one, two, three");
  });
});

describe("echoTranscriptFailure", () => {
  test("a voice note nobody could hear is told so, in place of the transcript", async () => {
    const telegram = recordingApi();

    await Effect.runPromise(
      echoTranscriptFailure({
        api: telegram.api,
        chatId: CHAT_ID,
        noticeId: NOTICE_ID,
      })
    );

    expect(
      String(lastTextOf({ calls: telegram.calls, method: "editMessageText" }))
    ).toContain(TRANSCRIPT_FAILED_TEXT);
  });

  test("and told so in a message of its own when there is no line to edit", async () => {
    const telegram = recordingApi();

    await Effect.runPromise(
      echoTranscriptFailure({
        api: telegram.api,
        chatId: CHAT_ID,
        noticeId: null,
      })
    );

    expect(
      String(lastTextOf({ calls: telegram.calls, method: "sendMessage" }))
    ).toContain(TRANSCRIPT_FAILED_TEXT);
  });
});
