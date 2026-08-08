/**
 * The three readings of a selected path that must never be drawn wrongly.
 *
 * An instruction file has to carry its size against the budget a run's whole
 * tree shares, because nothing else in the system tells anybody when the
 * deepest document starts being dropped. A file that is not text must never
 * reach the editor, because saving text over a binary destroys it silently. And
 * a symlink has to read as a symlink: it is half of how a skill is laid out and
 * also the shape a run plants to make something outside the tree be read.
 *
 * Rendered to static markup rather than through a browser: what is checked is
 * which elements exist for a given reading, and that is settled by the tree.
 */

import { describe, expect, test } from "bun:test";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { FileContent, FileEntry } from "@workspace/api";
import { renderToStaticMarkup } from "react-dom/server";
import { keys } from "@/api/keys";
import { FilePane } from "@/features/files/file-pane";
import { scopePathOf } from "@/lib/scope-path";

const nothing = () => undefined;

/** One listing row, with only the fields a case is about spelled out. */
const entryOf = (over: Partial<FileEntry>): FileEntry => ({
  bytes: null,
  ext: null,
  kind: "file",
  modifiedAt: null,
  name: "x",
  path: "x",
  target: null,
  targetOutsideScope: false,
  ...over,
});

interface Scene {
  /** The folder the pane reads the entry out of. Null is the scope's root. */
  readonly at?: string | null;
  readonly content?: FileContent;
  readonly listing: readonly FileEntry[];
  readonly path: string;
}

const markupFor = ({ at = null, content, listing, path }: Scene) => {
  const queryClient = new QueryClient();
  queryClient.setQueryData(keys.scopeListing("workspace", at), listing);
  if (content !== undefined) {
    queryClient.setQueryData(keys.scopeFile("workspace", path), content);
  }
  return renderToStaticMarkup(
    <QueryClientProvider client={queryClient}>
      <FilePane
        onSelect={nothing}
        path={scopePathOf(path)}
        scope={{ scope: "workspace" }}
      />
    </QueryClientProvider>
  );
};

describe("FilePane", () => {
  test("house rules are shown against the budget their whole tree shares", () => {
    const markup = markupFor({
      content: {
        bytes: 20_000,
        content: "# rules\n".repeat(2500),
        encoding: "utf8",
        path: "AGENTS.md",
      },
      listing: [
        entryOf({
          bytes: 20_000,
          ext: "md",
          name: "AGENTS.md",
          path: "AGENTS.md",
        }),
      ],
      path: "AGENTS.md",
    });

    expect(markup).toContain("Instruction budget used");
    expect(markup).toContain("across every level a run reads");
  });

  test("an ordinary document is not measured against it", () => {
    const markup = markupFor({
      content: {
        bytes: 12,
        content: "notes here\n",
        encoding: "utf8",
        path: "research.md",
      },
      listing: [
        entryOf({
          bytes: 12,
          ext: "md",
          name: "research.md",
          path: "research.md",
        }),
      ],
      path: "research.md",
    });

    expect(markup).not.toContain("Instruction budget used");
  });

  test("bytes that are not text never reach a box somebody can save", () => {
    const markup = markupFor({
      content: {
        bytes: 900,
        content: "AAAA",
        encoding: "base64",
        path: "logo.png",
      },
      listing: [
        entryOf({ bytes: 900, ext: "png", name: "logo.png", path: "logo.png" }),
      ],
      path: "logo.png",
    });

    expect(markup).toContain("not text");
    expect(markup).not.toContain("<textarea");
  });

  /**
   * Claude does not read `AGENTS.md` at all, so rules written into a folder
   * holding only that name reach one provider. The offer is made where the
   * rules were just written, and it says plainly that the folders this system
   * seeds do the same job with an import line instead — both work, and neither
   * is imposed.
   */
  test("rules with no second name are offered one, without being told to take it", () => {
    const markup = markupFor({
      content: {
        bytes: 12,
        content: "# rules\n",
        encoding: "utf8",
        path: "AGENTS.md",
      },
      listing: [
        entryOf({ bytes: 12, ext: "md", name: "AGENTS.md", path: "AGENTS.md" }),
      ],
      path: "AGENTS.md",
    });

    expect(markup).toContain("Claude does not read AGENTS.md");
    expect(markup).toContain("Link CLAUDE.md to this");
    expect(markup).toContain("import line");
  });

  test("rules that already have their pair are offered nothing", () => {
    const markup = markupFor({
      content: {
        bytes: 12,
        content: "# rules\n",
        encoding: "utf8",
        path: "AGENTS.md",
      },
      listing: [
        entryOf({ bytes: 12, ext: "md", name: "AGENTS.md", path: "AGENTS.md" }),
        entryOf({
          kind: "symlink",
          name: "CLAUDE.md",
          path: "CLAUDE.md",
          target: "AGENTS.md",
        }),
      ],
      path: "AGENTS.md",
    });

    expect(markup).not.toContain("Link CLAUDE.md to this");
  });

  test("a link is drawn as a link, with the file it really points at", () => {
    const markup = markupFor({
      at: ".claude",
      listing: [
        entryOf({
          kind: "symlink",
          name: "skills",
          path: ".claude/skills",
          target: "../.agents/skills",
        }),
      ],
      path: ".claude/skills",
    });

    expect(markup).toContain("A link, not a copy");
    expect(markup).toContain(".agents/skills");
  });

  test("a link out of the scope is marked and offers no way through", () => {
    const markup = markupFor({
      listing: [
        entryOf({
          kind: "symlink",
          name: "escape",
          path: "escape",
          target: "../../../etc",
          targetOutsideScope: true,
        }),
      ],
      path: "escape",
    });

    expect(markup).toContain("leaves this scope");
    expect(markup).not.toContain("Open ");
  });
});
