import { createHighlighter } from "@tanstack/highlight/core";
import * as languages from "@tanstack/highlight/languages";
import { createTanStackMarkdownHighlighter } from "@tanstack/highlight/markdown";
import { Markdown as TanStackMarkdown } from "@tanstack/markdown/react";
import type { MarkdownComponents } from "@tanstack/markdown/react";
import { autolinkLiterals, splitLinks } from "@workspace/ui/lib/autolink";
import { cn } from "@workspace/ui/lib/utils";
import type { ComponentProps } from "react";
import { useMemo } from "react";

/**
 * The languages a code fence can be written in here.
 *
 * The registry is the bundle: every language named costs its tokenizer, and
 * nothing else is shipped. This is what agents and this codebase actually
 * write — the highlighter falls back to plain text for anything else, which
 * reads as unhighlighted code rather than as an error.
 */
const LANGUAGES = [
  languages.css,
  languages.diff,
  languages.dockerfile,
  languages.env,
  languages.html,
  languages.http,
  languages.js,
  languages.json,
  languages.jsx,
  languages.markdown,
  languages.plaintext,
  languages.python,
  languages.shell,
  languages.sql,
  languages.toml,
  languages.ts,
  languages.tsx,
  languages.yaml,
] as const;

/**
 * One highlighter for the whole app.
 *
 * Building it walks the registry, so it is done once at module load rather
 * than per code block — a task with forty comments would otherwise build forty
 * identical ones.
 */
export const highlighter = createHighlighter({
  fallbackLanguage: "plaintext",
  languages: LANGUAGES,
});

/** The same highlighter in the shape the markdown renderer asks for. */
const highlightFence = createTanStackMarkdownHighlighter(highlighter);

/**
 * Whether a link leaves the app. Anything absolute does: agent output cites
 * documentation and issue trackers, and following one of those inside a task
 * panel would throw away whatever the reader had open.
 */
const isExternal = (href: string | undefined) =>
  href !== undefined && /^[a-z][\w+.-]*:/i.test(href);

const components = {
  a(props: ComponentProps<"a">) {
    const external = isExternal(props.href);
    return (
      <a
        {...props}
        rel={external ? "nofollow noopener noreferrer" : props.rel}
        target={external ? "_blank" : props.target}
      />
    );
  },
} satisfies MarkdownComponents;

/**
 * What the parser is taught beyond CommonMark. See `autolink.ts`: an address
 * pasted on its own is a link, which the parser does not do by itself and has
 * no option for.
 */
const EXTENSIONS = [autolinkLiterals];

/** A body and where it is drawn. The same two things whether it is parsed or not. */
interface TextProps {
  readonly children: string;
  readonly className?: string;
}

/**
 * Markdown, as the thing it describes rather than as its source.
 *
 * Everything an agent writes is markdown — reports, briefs, review notes — and
 * shown verbatim it reads as punctuation around the sentences. Raw HTML stays
 * off: the renderer escapes it, so a task body is never a place to run script,
 * which matters because the text on this page was written by a model reading
 * material nobody vetted. Autolinking comes from the parser for the same
 * reason: an extension emits link nodes, and no step here interpolates markup.
 *
 * Appearance lives in `markdown.css` under the class this wraps in, so the
 * twenty tags a document can emit are styled once instead of being mapped to
 * components one at a time.
 */
export const Markdown = ({ children, className }: TextProps) => (
  <div className={cn("markdown", className)}>
    <TanStackMarkdown
      components={components}
      extensions={EXTENSIONS}
      highlighter={highlightFence}
    >
      {children}
    </TanStackMarkdown>
  </div>
);

/**
 * Words somebody typed, shown as they typed them, with their addresses live.
 *
 * A person's own message is deliberately not markdown — asterisks and
 * underscores they typed are asterisks and underscores, and their line breaks
 * are theirs — which leaves a pasted URL in one with no renderer at all. So this
 * is the narrowest renderer there is: the same scan for addresses as the
 * document above, and no other syntax interpreted.
 *
 * Anchors carry the position of the address they came from as their key, and
 * `plain-text` is the class `markdown.css` styles them under — underlined in
 * the colour around them, because a person's words are drawn in the accent
 * bubble and an accent-coloured link there is invisible.
 */
export const PlainText = ({ children, className }: TextProps) => (
  <p className={cn("plain-text whitespace-pre-wrap", className)}>
    {splitLinks(children).map((run) =>
      run.kind === "text" ? (
        run.value
      ) : (
        <a
          href={run.href}
          key={run.start}
          rel="nofollow noopener noreferrer"
          target="_blank"
        >
          {run.value}
        </a>
      )
    )}
  </p>
);

interface CodeBlockProps {
  readonly className?: string;
  readonly code: string;
  /** The language to tokenise as; anything unregistered falls back to plain text. */
  readonly lang?: string;
  /** Numbers down the gutter — worth it for a whole file, noise for a fragment. */
  readonly lineNumbers?: boolean;
}

/**
 * A whole file, highlighted.
 *
 * Separate from a markdown fence because it starts from bytes rather than from
 * a document: the file viewer knows the language from the file's extension and
 * has no markdown to parse. The markup comes from the highlighter, which
 * escapes what it emits — the same trust boundary the fence renderer uses, and
 * the reason nothing here interpolates the source into HTML itself.
 */
export const CodeBlock = ({
  className,
  code,
  lang,
  lineNumbers = false,
}: CodeBlockProps) => {
  const html = useMemo(
    () => highlighter.highlightToHtml(code, { lang, lineNumbers }),
    [code, lang, lineNumbers]
  );

  return (
    <div
      className={cn("code-block", className)}
      // biome-ignore lint/security/noDangerouslySetInnerHtml: the markup is the highlighter's own, built from escaped source — there is no other way to hand it a tokenised tree.
      dangerouslySetInnerHTML={{ __html: html }}
    />
  );
};
