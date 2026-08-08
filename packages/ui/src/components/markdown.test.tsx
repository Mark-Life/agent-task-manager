import { describe, expect, test } from "bun:test";
import { Markdown, PlainText } from "@workspace/ui/components/markdown";
import type { ReactElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

/**
 * The two renderers behind every surface that shows a body: a task brief and its
 * acceptance criteria and an agent's message go through `Markdown`, and a
 * message somebody typed goes through `PlainText`. Rendered to markup rather
 * than to a DOM, because what is being checked is what the anchor says.
 */
const html = (element: ReactElement) => renderToStaticMarkup(element);

const BARE = "https://github.com/Mark-Life/agent-task-manager/pull/38";
const WRITTEN = "[pull request](https://github.com/Mark-Life/agent-task-manager/pull/38)";

describe("Markdown", () => {
  test("a bare address opens in a new tab", () => {
    expect(html(<Markdown>{BARE}</Markdown>)).toContain(
      `<a href="${BARE}" rel="nofollow noopener noreferrer" target="_blank">${BARE}</a>`
    );
  });

  test("a written link still opens in a new tab", () => {
    expect(html(<Markdown>{WRITTEN}</Markdown>)).toContain(
      `<a href="${BARE}" rel="nofollow noopener noreferrer" target="_blank">pull request</a>`
    );
  });

  test("an in-app address is followed in place", () => {
    const markup = html(<Markdown>{"[a task](/tasks/abc)"}</Markdown>);
    expect(markup).toContain('href="/tasks/abc"');
    expect(markup).not.toContain("_blank");
  });

  test("markup in the source is text", () => {
    const markup = html(
      <Markdown>{'<img src=x onerror="alert(1)"><script>alert(1)</script>'}</Markdown>
    );
    expect(markup).not.toContain("<img");
    expect(markup).not.toContain("<script");
    expect(markup).toContain(
      "&lt;img src=x onerror=&quot;alert(1)&quot;&gt;&lt;script&gt;alert(1)&lt;/script&gt;"
    );
  });
});

describe("PlainText", () => {
  test("a bare address opens in a new tab", () => {
    expect(html(<PlainText>{`look: ${BARE}`}</PlainText>)).toContain(
      `<a href="${BARE}" rel="nofollow noopener noreferrer" target="_blank">${BARE}</a>`
    );
  });

  test("a written link is not markdown here, but its address is still a link", () => {
    const markup = html(<PlainText>{WRITTEN}</PlainText>);
    expect(markup).toContain(`<a href="${BARE}"`);
    expect(markup).toContain("[pull request](");
  });

  test("markdown around the address is left as typed", () => {
    const markup = html(<PlainText>{"**not bold** _not italic_"}</PlainText>);
    expect(markup).toContain("**not bold** _not italic_");
    expect(markup).not.toContain("<strong");
  });

  test("newlines a person typed are kept", () => {
    expect(html(<PlainText>{"one\ntwo"}</PlainText>)).toContain(
      "whitespace-pre-wrap"
    );
  });

  test("markup in the source is text", () => {
    const markup = html(
      <PlainText>{'<img src=x onerror="alert(1)"><script>alert(1)</script>'}</PlainText>
    );
    expect(markup).not.toContain("<img");
    expect(markup).not.toContain("<script");
    expect(markup).toContain(
      "&lt;img src=x onerror=&quot;alert(1)&quot;&gt;&lt;script&gt;alert(1)&lt;/script&gt;"
    );
  });
});
