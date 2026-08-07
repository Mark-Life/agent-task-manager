/**
 * Rich messages, read as words.
 *
 * A rich message is the Bot API's structured document: headings, lists, tables,
 * code blocks, block quotations, media with captions. It arrives in
 * `message.rich_message` as a tree of blocks — and, decisively for the handler
 * one directory up, it arrives with **no `text` and no `caption` at all**. A bot
 * that answers with `sendRichMessage` produces messages whose every word lives
 * in that tree, which is why forwarding one into this chat used to be refused as
 * an unsupported attachment: the classifier looked in the two places the Bot API
 * usually puts words, found neither, and fell through.
 *
 * This module is the third place to look. {@link richMessageToText} turns the
 * tree into one string the manager can read, and the manager is the only reader
 * that matters: it reasons over text, so a table nobody flattened is a table it
 * cannot see.
 *
 * **Structure is kept, in Markdown, because it is nearly free.** A heading, a
 * numbered list and a fenced code block each cost one line here and each carry
 * meaning a flattened paragraph would lose — "```ts" above a snippet is the
 * difference between code and prose to whatever reads this next. What is dropped
 * is what has no words in it: an anchor is a link target, a divider is a rule,
 * and a photo is a photo. Their captions are kept, because those are words.
 *
 * **The types are derived, never restated.** grammy already models every block
 * and every span; re-declaring them here is how a new Bot API block type becomes
 * a silent `undefined` instead of a compile error.
 */

import type { TelegramMessage } from "./intake";

/** The document a rich message carries, as grammy models it. */
export type RichMessage = NonNullable<TelegramMessage["rich_message"]>;

/** One node of that document: a paragraph, a list, a table, a photo. */
export type RichBlock = RichMessage["blocks"][number];

/** A span of formatted text, which is a tree in its own right. */
type RichText = Extract<RichBlock, { type: "paragraph" }>["text"];

/** The words above a media block, and who they are credited to. */
type RichCaption = Extract<RichBlock, { type: "photo" }>["caption"];

/** One row of a table. */
type RichTableRow = Extract<RichBlock, { type: "table" }>["cells"][number];

/** One entry of a list. */
type RichListItem = Extract<RichBlock, { type: "list" }>["items"][number];

/** What separates two blocks: a blank line, as in the document they came from. */
const BLOCK_SEPARATOR = "\n\n";

/**
 * The words in a span.
 *
 * Every span variant but three nests its text under `text`, so the recursion is
 * the whole implementation. The three that do not are the ones whose content is
 * not text at all: a custom emoji stands for the emoji it falls back to, a
 * formula stands for its LaTeX, and an anchor is a name nobody reads — it is a
 * place in the document rather than a word in it.
 */
export const richTextToPlain = (rich: RichText): string => {
  if (typeof rich === "string") {
    return rich;
  }
  if (Array.isArray(rich)) {
    return rich.map(richTextToPlain).join("");
  }
  if ("text" in rich) {
    return richTextToPlain(rich.text);
  }
  if (rich.type === "custom_emoji") {
    return rich.alternative_text;
  }
  if (rich.type === "mathematical_expression") {
    return rich.expression;
  }
  return "";
};

/** A caption and its credit, as one line each. */
const captionToText = (caption: RichCaption) => {
  if (caption === undefined) {
    return "";
  }
  const credit =
    caption.credit === undefined ? "" : richTextToPlain(caption.credit);
  return [richTextToPlain(caption.text), credit].filter(Boolean).join("\n");
};

/** A quotation's lines, each marked as quoted so the nesting survives flattening. */
const quoted = (text: string) =>
  text
    .split("\n")
    .map((line) => `> ${line}`)
    .join("\n");

/** One list entry under its own label, with a checkbox when it has one. */
const listItemToText = (item: RichListItem) => {
  const box =
    item.has_checkbox === true
      ? `[${item.is_checked === true ? "x" : " "}] `
      : "";
  // Telegram numbers and bullets the items itself; the label is what it chose.
  return `${item.label} ${box}${blocksToText(item.blocks)}`.trimEnd();
};

/** One table row as a Markdown row, invisible cells included as empty ones. */
const tableRowToText = (row: RichTableRow) =>
  `| ${row.map((cell) => (cell.text === undefined ? "" : richTextToPlain(cell.text))).join(" | ")} |`;

/**
 * One block as text.
 *
 * Ordered most specific first, and ending on the three shapes that share a field
 * rather than a type — a block with text in it, a block with blocks in it, a
 * block with only a caption — so a block type added to the Bot API tomorrow
 * still yields its words instead of nothing.
 */
export const richBlockToText = (block: RichBlock): string => {
  if (block.type === "heading") {
    return `${"#".repeat(block.size)} ${richTextToPlain(block.text)}`;
  }
  if (block.type === "pre") {
    return `\`\`\`${block.language ?? ""}\n${richTextToPlain(block.text)}\n\`\`\``;
  }
  if (block.type === "divider") {
    return "---";
  }
  if (block.type === "mathematical_expression") {
    return block.expression;
  }
  if (block.type === "list") {
    return block.items.map(listItemToText).join("\n");
  }
  if (block.type === "blockquote") {
    const credit =
      block.credit === undefined ? "" : `\n— ${richTextToPlain(block.credit)}`;
    return `${quoted(blocksToText(block.blocks))}${credit}`;
  }
  if (block.type === "table") {
    const rows = block.cells.map(tableRowToText).join("\n");
    const caption =
      block.caption === undefined ? "" : richTextToPlain(block.caption);
    return [rows, caption].filter(Boolean).join("\n");
  }
  if (block.type === "details") {
    return [richTextToPlain(block.summary), blocksToText(block.blocks)]
      .filter(Boolean)
      .join("\n");
  }
  if ("blocks" in block) {
    return [blocksToText(block.blocks), captionToText(block.caption)]
      .filter(Boolean)
      .join("\n");
  }
  if ("text" in block) {
    return richTextToPlain(block.text);
  }
  if ("caption" in block) {
    return captionToText(block.caption);
  }
  // An anchor names a place in the document. There is nothing to read.
  return "";
};

/** A run of blocks, one blank line apart, with the wordless ones left out. */
const blocksToText = (blocks: readonly RichBlock[]): string =>
  blocks.map(richBlockToText).filter(Boolean).join(BLOCK_SEPARATOR);

/**
 * A rich message as the words it holds — empty when it holds none, which is a
 * document of nothing but photos and dividers and is refused upstream like any
 * other message with nothing to read in it.
 */
export const richMessageToText = (rich: RichMessage): string =>
  blocksToText(rich.blocks).trim();
