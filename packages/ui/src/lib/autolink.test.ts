import { describe, expect, test } from "bun:test";
import { renderHtml } from "@tanstack/markdown/html";
import { autolinkLiterals, splitLinks } from "@workspace/ui/lib/autolink";

/** The extension as the renderer uses it, so a case is a document, not an AST. */
const render = (markdown: string) =>
  renderHtml(markdown, { extensions: [autolinkLiterals] });

describe("splitLinks", () => {
  test("an address on its own is one link", () => {
    expect(splitLinks("https://example.com")).toEqual([
      {
        href: "https://example.com",
        kind: "link",
        start: 0,
        value: "https://example.com",
      },
    ]);
  });

  test("an address in a sentence keeps the words around it", () => {
    expect(splitLinks("see https://example.com/x now")).toEqual([
      { kind: "text", start: 0, value: "see " },
      {
        href: "https://example.com/x",
        kind: "link",
        start: 4,
        value: "https://example.com/x",
      },
      { kind: "text", start: 25, value: " now" },
    ]);
  });

  test("sentence punctuation after an address stays text", () => {
    const runs = splitLinks("ship it: https://example.com/a.");
    expect(runs.at(-2)).toMatchObject({ value: "https://example.com/a" });
    expect(runs.at(-1)).toEqual({ kind: "text", start: 30, value: "." });
  });

  test("an address wrapped in parentheses does not eat the closing one", () => {
    expect(splitLinks("(https://example.com/a)")).toEqual([
      { kind: "text", start: 0, value: "(" },
      {
        href: "https://example.com/a",
        kind: "link",
        start: 1,
        value: "https://example.com/a",
      },
      { kind: "text", start: 22, value: ")" },
    ]);
  });

  test("an address that opened a parenthesis keeps its closing one", () => {
    expect(splitLinks("https://en.wikipedia.org/wiki/Ada_(name)")).toEqual([
      {
        href: "https://en.wikipedia.org/wiki/Ada_(name)",
        kind: "link",
        start: 0,
        value: "https://en.wikipedia.org/wiki/Ada_(name)",
      },
    ]);
  });

  test("angle brackets delimit an address rather than joining it", () => {
    expect(splitLinks("<https://example.com>")).toEqual([
      {
        href: "https://example.com",
        kind: "link",
        start: 0,
        value: "https://example.com",
      },
    ]);
  });

  test("a scheme-less host is offered over https", () => {
    expect(splitLinks("www.example.com")).toEqual([
      {
        href: "https://www.example.com",
        kind: "link",
        start: 0,
        value: "www.example.com",
      },
    ]);
  });

  test("two addresses on two lines are two links", () => {
    const runs = splitLinks("https://a.example\nhttps://b.example");
    expect(runs.map((run) => run.kind)).toEqual(["link", "text", "link"]);
  });

  test("a scheme with no host is not an address", () => {
    expect(splitLinks("https://")).toEqual([
      { kind: "text", start: 0, value: "https://" },
    ]);
  });

  test("an address may not start mid-word", () => {
    expect(splitLinks("nothttps://example.com")).toEqual([
      { kind: "text", start: 0, value: "nothttps://example.com" },
    ]);
  });

  test("only the two web schemes are addresses", () => {
    for (const hostile of [
      "javascript:alert(1)",
      "data:text/html,<script>alert(1)</script>",
      "vbscript:msgbox(1)",
    ]) {
      expect(splitLinks(hostile).every((run) => run.kind === "text")).toBe(true);
    }
  });

  test("text with no address is one run", () => {
    expect(splitLinks("nothing here")).toEqual([
      { kind: "text", start: 0, value: "nothing here" },
    ]);
  });

  test("an empty string has no runs", () => {
    expect(splitLinks("")).toEqual([]);
  });
});

describe("autolinkLiterals", () => {
  test("a bare address in a paragraph becomes an anchor", () => {
    expect(render("https://example.com/x")).toContain(
      '<a href="https://example.com/x">https://example.com/x</a>'
    );
  });

  test("a written link still works", () => {
    expect(render("[docs](https://example.com)")).toContain(
      '<a href="https://example.com">docs</a>'
    );
  });

  test("an address inside a written link's text is not a second anchor", () => {
    const html = render("[https://example.com](https://other.example)");
    expect(html).toContain('<a href="https://other.example">');
    expect(html.match(/<a /g)).toHaveLength(1);
  });

  test("an address inside emphasis is still linked", () => {
    expect(render("**see https://example.com**")).toContain(
      '<a href="https://example.com">'
    );
  });

  test("an address in a list item is linked", () => {
    expect(render("- https://example.com")).toContain(
      '<a href="https://example.com">'
    );
  });

  test("an address in a table cell is linked", () => {
    const html = render("| where |\n| --- |\n| https://example.com |");
    expect(html).toContain('<a href="https://example.com">');
  });

  test("an address in code is quoted, not offered", () => {
    expect(render("`https://example.com`")).not.toContain("<a ");
    expect(render("```\nhttps://example.com\n```")).not.toContain("<a ");
  });

  test("html stays escaped", () => {
    const html = render('<img src=x onerror="alert(1)"> <script>alert(1)</script>');
    expect(html).not.toContain("<img");
    expect(html).not.toContain("<script");
    expect(html).toContain("&lt;script&gt;");
  });
});
