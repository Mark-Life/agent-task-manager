/**
 * A rich message is the one message shape whose words are not in a string, so
 * every test here is a way of hiding words in the tree and proving they come
 * back out. The bug this module exists for was not a mangled flattening — it was
 * a message whose whole content was invisible to the classifier — so the case
 * that matters most is the plainest one: a bot's formatted answer, read as text.
 */

import { describe, expect, test } from "bun:test";
import {
  type RichBlock,
  type RichMessage,
  richMessageToText,
  richTextToPlain,
} from "./rich";

const message = (...blocks: RichBlock[]) => ({ blocks }) as RichMessage;

describe("richTextToPlain", () => {
  test("reads through nesting, arrays and every decorated span", () => {
    const rich = [
      "plain ",
      { text: "bold ", type: "bold" },
      {
        text: [{ text: "deep", type: "italic" }, " nested"],
        type: "underline",
      },
      { text: " linked", type: "url", url: "https://example.com" },
      { text: " @someone", type: "mention", username: "someone" },
    ] as Parameters<typeof richTextToPlain>[0];
    expect(richTextToPlain(rich)).toBe(
      "plain bold deep nested linked @someone"
    );
  });

  test("spans that are not text stand for what a reader would see", () => {
    expect(
      richTextToPlain({
        alternative_text: "🎉",
        custom_emoji_id: "1",
        type: "custom_emoji",
      } as Parameters<typeof richTextToPlain>[0])
    ).toBe("🎉");
    expect(
      richTextToPlain({
        expression: "E = mc^2",
        type: "mathematical_expression",
      } as Parameters<typeof richTextToPlain>[0])
    ).toBe("E = mc^2");
    // An anchor is a place in the document, not a word in it.
    expect(
      richTextToPlain({ name: "section-2", type: "anchor" } as Parameters<
        typeof richTextToPlain
      >[0])
    ).toBe("");
  });
});

describe("richMessageToText", () => {
  test("a bot's formatted answer comes back as the words it said", () => {
    const text = richMessageToText(
      message(
        { size: 2, text: "Fresh batch", type: "heading" },
        {
          text: [
            "grouped by the ",
            { text: "viral mechanic", type: "bold" },
            " they trigger",
          ],
          type: "paragraph",
        }
      ) as RichMessage
    );
    expect(text).toBe(
      "## Fresh batch\n\ngrouped by the viral mechanic they trigger"
    );
  });

  test("structure survives as Markdown: lists, code and quotations", () => {
    const text = richMessageToText(
      message(
        {
          items: [
            {
              blocks: [{ text: "Guess the language", type: "paragraph" }],
              label: "1.",
              value: 1,
            },
            {
              blocks: [{ text: "Score me", type: "paragraph" }],
              has_checkbox: true,
              is_checked: true,
              label: "2.",
            },
          ],
          type: "list",
        },
        { language: "ts", text: "const x = 1", type: "pre" },
        {
          blocks: [{ text: "worth reading twice", type: "paragraph" }],
          credit: "Ada",
          type: "blockquote",
        }
      ) as RichMessage
    );
    expect(text).toBe(
      [
        "1. Guess the language\n2. [x] Score me",
        "```ts\nconst x = 1\n```",
        "> worth reading twice\n— Ada",
      ].join("\n\n")
    );
  });

  test("a table keeps its rows, and an invisible cell stays a column", () => {
    const text = richMessageToText(
      message({
        cells: [
          [
            { align: "left", is_header: true, text: "idea", valign: "top" },
            { align: "left", is_header: true, text: "effort", valign: "top" },
          ],
          [
            { align: "left", text: "roast card", valign: "top" },
            { align: "left", valign: "top" },
          ],
        ],
        type: "table",
      } as RichBlock) as RichMessage
    );
    expect(text).toBe("| idea | effort |\n| roast card |  |");
  });

  test("media keeps its caption and drops the rest — a photo has no words", () => {
    const text = richMessageToText(
      message(
        {
          caption: { credit: "Ada", text: "the chart" },
          photo: [{ file_id: "p", file_unique_id: "u", height: 1, width: 1 }],
          type: "photo",
        },
        { type: "divider" },
        { name: "top", type: "anchor" }
      ) as RichMessage
    );
    expect(text).toBe("the chart\nAda\n\n---");
  });

  test("a document with nothing to read is empty rather than noise", () => {
    expect(
      richMessageToText(
        message({ name: "top", type: "anchor" } as RichBlock) as RichMessage
      )
    ).toBe("");
  });
});
