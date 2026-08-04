import { describe, expect, test } from "bun:test";
import { blockquote, bold, code, formatFooter, link, taskLine } from "./format";

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
