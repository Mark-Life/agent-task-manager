import { describe, expect, test } from "bun:test";
import {
  blockquote,
  bold,
  code,
  formatFooter,
  link,
  renderReasoning,
  renderToolLines,
  taskLine,
} from "./format";

describe("html primitives", () => {
  test("escape what they wrap", () => {
    expect(bold("a<b>")).toBe("<b>a&lt;b&gt;</b>");
    expect(code("<script>")).toBe("<code>&lt;script&gt;</code>");
  });

  test("escape a link label but not its url", () => {
    expect(link({ label: "a & b", url: "https://x.dev/?a=1&b=2" })).toBe(
      '<a href="https://x.dev/?a=1&b=2">a &amp; b</a>'
    );
  });
});

describe("blockquote", () => {
  test("stays plain when it is short", () => {
    expect(blockquote({ text: "one\ntwo" })).toBe(
      "<blockquote>one\ntwo</blockquote>"
    );
  });

  test("collapses once it is long enough to be in the way", () => {
    expect(blockquote({ text: "a\nb\nc\nd" })).toContain(
      "<blockquote expandable>"
    );
  });
});

describe("renderToolLines", () => {
  test("keeps the plain text beside the markup", () => {
    const rendered = renderToolLines(["Read: a.ts", "Edit: b.ts"]);
    expect(rendered.plain).toBe("Read: a.ts\nEdit: b.ts");
    expect(rendered.html).toBe("<i>Read: a.ts</i>\n<i>Edit: b.ts</i>");
  });

  test("collapses a long trace", () => {
    const rendered = renderToolLines(["a", "b", "c", "d"]);
    expect(rendered.html.startsWith("<blockquote expandable>")).toBe(true);
  });

  test("escapes a tool summary", () => {
    expect(renderToolLines(["Bash: <rm>"]).html).toContain("&lt;rm&gt;");
  });
});

describe("renderReasoning", () => {
  test("keeps the tail, not the head", () => {
    const rendered = renderReasoning({ maxChars: 203, text: "abcdefghij" });
    expect(rendered.plain).toBe("...hij");
  });

  test("leaves short text whole", () => {
    expect(renderReasoning({ maxChars: 1000, text: "short" }).plain).toBe(
      "short"
    );
  });
});

describe("formatFooter", () => {
  test("is empty when the turn reported nothing", () => {
    expect(
      formatFooter({
        costUsd: null,
        durationMs: null,
        totalTokens: null,
        turns: null,
      })
    ).toBe("");
  });

  test("drops a null cost rather than claiming zero", () => {
    const footer = formatFooter({
      costUsd: null,
      durationMs: 1500,
      totalTokens: null,
      turns: null,
    });
    expect(footer).toBe("<i>1.5s</i>");
    expect(footer).not.toContain("$");
  });

  test("shows every field the turn did report", () => {
    expect(
      formatFooter({
        costUsd: 0.0312,
        durationMs: 4200,
        totalTokens: 15_400,
        turns: 3,
      })
    ).toBe("<i>$0.0312 · 4.2s · 15.4k tokens · 3 turns</i>");
  });

  test("hides a single turn, which says nothing", () => {
    expect(
      formatFooter({
        costUsd: null,
        durationMs: null,
        totalTokens: null,
        turns: 1,
      })
    ).toBe("");
  });
});

describe("taskLine", () => {
  test("escapes the title and keeps the id copyable", () => {
    expect(
      taskLine({ id: "abc", status: "review", title: "fix <a> tags" })
    ).toBe("👀 <b>fix &lt;a&gt; tags</b>\n<code>abc</code>");
  });
});
