import type { InlineNode, MarkdownExtension } from "@tanstack/markdown";

/**
 * Addresses written as themselves, turned into links.
 *
 * `@tanstack/markdown` implements CommonMark plus most of GFM — tables and
 * strikethrough are built in and unconditional — but not autolink literals, and
 * it has no option that switches them on. So a bare `https://example.com`
 * parses to one text node and renders as dead text, while `[text](url)` has
 * always worked. Bare is how almost every link reaches this app: a person
 * pastes a task or pull request URL into a message, an agent cites
 * documentation the same way, and neither writes bracket-paren syntax.
 *
 * This is the whole answer, in one place, because the two surfaces that need it
 * are not both markdown. `autolinkLiterals` is a parser extension, so the
 * markdown renderer gains links without gaining raw HTML — the text on these
 * pages was written by a model reading unvetted material, so nothing here is
 * allowed to widen that boundary. `splitLinks` is the same scan over a plain
 * string, for text a person typed, which is deliberately not parsed as markdown.
 *
 * Only `http` and `https` are ever produced. A `javascript:` or `data:` literal
 * is not a link this recognises, so no click can follow one.
 */

/**
 * One run of a string: either words, or an address.
 *
 * `start` is where the run begins in the string it came from. It is what a
 * renderer keys its anchors by — a run's identity is its position, not its
 * index in whatever array it lands in.
 */
export type TextRun =
  | { readonly kind: "text"; readonly start: number; readonly value: string }
  | {
      readonly href: string;
      readonly kind: "link";
      readonly start: number;
      readonly value: string;
    };

/**
 * What an address in running text looks like.
 *
 * Three forms, in the order they are tried. `<https://example.com>` is
 * CommonMark's own autolink, which this parser also leaves as text — the angle
 * brackets are the delimiters and never part of the address. Then the two web
 * schemes, then `www.`, which is the one hostname people paste without a scheme.
 *
 * A literal runs to the first space or angle bracket; where that overshoots,
 * `trimTail` walks it back. It may not start mid-word, so `see:https://x` links
 * and `nothttps://x` does not.
 */
const LITERAL = /<(https?:\/\/[^\s<>]+)>|(?<![\w@])(?:https?:\/\/|www\.)[^\s<>]+/gi;

/**
 * Punctuation that belongs to the sentence rather than to the address, taken
 * one character at a time from the end. GFM's list, and the reason
 * `see https://example.com.` links the URL and keeps the full stop.
 */
const TRAILING = /["'*,.:;!?_~]$/;

/** A scheme-less hostname, which is https in every case that reaches here. */
const WWW = /^www\./i;

/** A prefix with nothing after it is not an address. */
const HOSTED = /^(?:https?:\/\/|www\.)[\w-]/i;

const occurrences = (value: string, char: string) => {
  let found = 0;
  for (const candidate of value) {
    if (candidate === char) {
      found++;
    }
  }
  return found;
};

/**
 * The address without the punctuation that followed it.
 *
 * A closing paren is kept when the address opened one, which is what a
 * Wikipedia link needs, and dropped when it did not, which is what an address
 * written inside parentheses needs.
 */
const trimTail = (value: string): string => {
  if (TRAILING.test(value)) {
    return trimTail(value.slice(0, -1));
  }
  if (value.endsWith(")") && occurrences(value, ")") > occurrences(value, "(")) {
    return trimTail(value.slice(0, -1));
  }
  return value;
};

/** Every address in a string, with the text between them, in order. */
export const splitLinks = (value: string): readonly TextRun[] => {
  const runs: TextRun[] = [];
  let cursor = 0;

  LITERAL.lastIndex = 0;
  for (
    let match = LITERAL.exec(value);
    match !== null;
    match = LITERAL.exec(value)
  ) {
    const bracketed = match[1];
    const url = bracketed ?? trimTail(match[0]);
    if (!HOSTED.test(url)) {
      continue;
    }

    const start = match.index;
    if (start > cursor) {
      runs.push({ kind: "text", start: cursor, value: value.slice(cursor, start) });
    }
    runs.push({
      href: WWW.test(url) ? `https://${url}` : url,
      kind: "link",
      start,
      value: url,
    });

    // Past the address, not past the match: the punctuation `trimTail` gave
    // back is text, and the next address may be sitting right behind it.
    cursor = start + (bracketed === undefined ? url.length : match[0].length);
    LITERAL.lastIndex = cursor;
  }

  if (cursor < value.length) {
    runs.push({ kind: "text", start: cursor, value: value.slice(cursor) });
  }
  return runs;
};

/**
 * One inline node, with any address inside it lifted out as a link.
 *
 * The recursion is this extension's own because `transformInline` is handed
 * only the top level of each inline parse: emphasis and strong build their
 * children separately, so `**see https://example.com**` arrives as a strong
 * node holding raw text. A link is returned untouched — the text of
 * `[docs](https://example.com)` must not sprout an anchor inside an anchor —
 * and so is code, where an address is being quoted rather than offered.
 */
const linkify = (node: InlineNode): InlineNode[] => {
  if (node.type === "text") {
    return splitLinks(node.value).map((run): InlineNode =>
      run.kind === "link"
        ? {
            children: [{ type: "text", value: run.value }],
            href: run.href,
            type: "link",
          }
        : { type: "text", value: run.value }
    );
  }
  if (
    node.type === "strong" ||
    node.type === "emphasis" ||
    node.type === "strike"
  ) {
    return [{ ...node, children: node.children.flatMap(linkify) }];
  }
  return [node];
};

/** Autolink literals, as the parser extension the renderer is given. */
export const autolinkLiterals: MarkdownExtension = {
  name: "autolink-literals",
  transformInline: (nodes) => nodes.flatMap(linkify),
};
