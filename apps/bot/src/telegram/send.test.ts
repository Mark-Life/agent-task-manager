import { describe, expect, test } from "bun:test";
import { Effect } from "effect";
import {
  lastCallOf,
  lastTextOf,
  recordingApi,
  richMarkdownsOf,
} from "../testing/telegram";
import { DEFAULT_SPLIT_AT, sendRich, splitMarkdown, splitText } from "./send";

const repeat = (text: string, times: number) => text.repeat(times);

const CHAT_ID = 4242;

describe("splitText", () => {
  test("leaves short text alone", () => {
    expect(splitText({ text: "hello" })).toEqual(["hello"]);
  });

  test("leaves text exactly at the limit alone", () => {
    const text = repeat("a", DEFAULT_SPLIT_AT);
    expect(splitText({ text })).toEqual([text]);
  });

  test("splits at the last newline past halfway", () => {
    const text = `${repeat("a", 7)}\n${repeat("b", 7)}`;
    expect(splitText({ maxLength: 10, text })).toEqual([
      repeat("a", 7),
      `\n${repeat("b", 7)}`,
    ]);
  });

  test("hard-cuts when the only newline is too early", () => {
    const text = `a\n${repeat("b", 20)}`;
    expect(splitText({ maxLength: 10, text })[0]).toBe(text.slice(0, 10));
  });

  test("hard-cuts when there is no newline at all", () => {
    expect(splitText({ maxLength: 10, text: repeat("a", 25) })).toEqual([
      repeat("a", 10),
      repeat("a", 10),
      repeat("a", 5),
    ]);
  });

  test("is lossless — the chunks rebuild the input", () => {
    const text = Array.from({ length: 400 }, (_, i) => `line ${i}`).join("\n");
    expect(splitText({ maxLength: 200, text }).join("")).toBe(text);
  });

  test("every chunk fits the budget", () => {
    const text = Array.from({ length: 400 }, (_, i) => `line ${i}`).join("\n");
    for (const chunk of splitText({ maxLength: 200, text })) {
      expect(chunk.length).toBeLessThanOrEqual(200);
    }
  });

  test("terminates on a pathological budget", () => {
    expect(splitText({ maxLength: 0, text: "abc" })).toEqual(["a", "b", "c"]);
  });
});

/** A body with one long fenced block in the middle of it. */
const fencedBody = (lines: number) =>
  [
    "Here is the fix.",
    "",
    "```ts",
    ...Array.from({ length: lines }, (_, i) => `const line${i} = ${i};`),
    "```",
    "",
    "That is all.",
  ].join("\n");

/** The same text with every fence line dropped, on both sides of a split. */
const withoutFences = (text: string) =>
  text
    .split("\n")
    .filter((line) => !line.startsWith("```"))
    .join("\n");

/** How many fence lines a piece of Markdown opens or closes. */
const fenceCount = (text: string) =>
  text.split("\n").filter((line) => line.startsWith("```")).length;

describe("splitMarkdown", () => {
  test("leaves a body under the limit whole", () => {
    const text = fencedBody(2);
    expect(splitMarkdown({ text })).toEqual([text]);
  });

  test("a body with no fences splits exactly like plain text", () => {
    const text = Array.from({ length: 400 }, (_, i) => `line ${i}`).join("\n");
    expect(splitMarkdown({ maxLength: 200, text })).toEqual(
      splitText({ maxLength: 200, text })
    );
  });

  test("a fence cut in half is closed and reopened, language and all", () => {
    const chunks = splitMarkdown({ maxLength: 200, text: fencedBody(40) });

    expect(chunks.length).toBeGreaterThan(1);
    for (const chunk of chunks) {
      expect(fenceCount(chunk) % 2).toBe(0);
    }
    expect(chunks[1]?.startsWith("```ts")).toBeTrue();
  });

  test("no chunk ends inside a code block", () => {
    const chunks = splitMarkdown({ maxLength: 200, text: fencedBody(40) });
    // An odd number of fence lines is an unterminated block, which renders as
    // prose — the failure this split exists to prevent.
    for (const chunk of chunks) {
      expect(fenceCount(chunk) % 2).toBe(0);
    }
  });

  test("keeps every word — only fences are added", () => {
    const text = fencedBody(40);
    const chunks = splitMarkdown({ maxLength: 200, text });

    expect(withoutFences(chunks.join(""))).toBe(withoutFences(text));
  });

  test("every chunk fits the budget, closing fence included", () => {
    for (const chunk of splitMarkdown({
      maxLength: 200,
      text: fencedBody(40),
    })) {
      expect(chunk.length).toBeLessThanOrEqual(200);
    }
  });

  test("a tilde fence closes with tildes", () => {
    const text = [
      "~~~python",
      ...Array.from({ length: 40 }, (_, i) => `line = ${i}`),
      "~~~",
    ].join("\n");
    const chunks = splitMarkdown({ maxLength: 200, text });

    expect(chunks.length).toBeGreaterThan(1);
    expect(chunks[0]?.endsWith("~~~")).toBeTrue();
    expect(chunks[1]?.startsWith("~~~python")).toBeTrue();
  });

  test("terminates on a pathological budget", () => {
    expect(splitMarkdown({ maxLength: 0, text: "abc" })).toEqual([
      "a",
      "b",
      "c",
    ]);
  });
});

describe("sendRich", () => {
  test("a Markdown body reaches the API as a rich message, unescaped", async () => {
    const telegram = recordingApi();
    const markdown = "## Heading\n\n**bold** and `code` & <Thing>";

    await Effect.runPromise(
      sendRich({ api: telegram.api, chatId: CHAT_ID, markdown })
    );

    const call = lastCallOf({
      calls: telegram.calls,
      method: "sendRichMessage",
    });
    expect(call?.payload.rich_message).toEqual({ markdown });
    expect(
      lastTextOf({ calls: telegram.calls, method: "sendMessage" })
    ).toBeNull();
  });

  test("a refused rich send still reaches the chat, with its words intact", async () => {
    const telegram = recordingApi({ refuse: ["sendRichMessage"] });
    const markdown = "**bold** and a ```unclosed fence";

    const sent = await Effect.runPromise(
      sendRich({ api: telegram.api, chatId: CHAT_ID, markdown })
    );

    expect(lastTextOf({ calls: telegram.calls, method: "sendMessage" })).toBe(
      markdown
    );
    // No parse mode on the way out: the fallback exists because the markup was
    // refused, so sending it as markup again is the same 400 twice.
    const call = lastCallOf({ calls: telegram.calls, method: "sendMessage" });
    expect(call?.payload.parse_mode).toBeUndefined();
    expect(sent.at(-1)?.message_id).toBeGreaterThan(0);
  });

  test("a long body is split, and each piece is sent in order", async () => {
    const telegram = recordingApi();

    await Effect.runPromise(
      sendRich({
        api: telegram.api,
        chatId: CHAT_ID,
        markdown: fencedBody(40),
        splitAt: 200,
      })
    );

    const sent = richMarkdownsOf({ calls: telegram.calls });
    expect(sent.length).toBeGreaterThan(1);
    expect(withoutFences(sent.join(""))).toBe(withoutFences(fencedBody(40)));
  });

  test("the keyboard rides the last chunk and the reply link the first", async () => {
    const telegram = recordingApi();
    const keyboard = { inline_keyboard: [] };

    await Effect.runPromise(
      sendRich({
        api: telegram.api,
        chatId: CHAT_ID,
        markdown: fencedBody(40),
        send: {
          reply_markup: keyboard,
          reply_parameters: { message_id: 7 },
        },
        splitAt: 200,
      })
    );

    const calls = telegram.calls.filter(
      (call) => call.method === "sendRichMessage"
    );
    expect(calls.at(0)?.payload.reply_parameters).toEqual({ message_id: 7 });
    expect(calls.at(0)?.payload.reply_markup).toBeUndefined();
    expect(calls.at(-1)?.payload.reply_markup).toEqual(keyboard);
    expect(calls.at(-1)?.payload.reply_parameters).toBeUndefined();
  });
});
