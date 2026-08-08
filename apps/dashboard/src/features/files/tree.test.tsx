/**
 * A tree that quietly dropped a row would be a tree saying a folder is empty
 * when a run can see something in it.
 *
 * So every entry is listed, including the two the routes cannot act on: a name
 * carrying a character no request can spell, and a link pointing out of the
 * scope. Both are drawn and neither is clickable — the honest pair. Offering to
 * open either would send a request the server refuses, and hiding either would
 * be this screen disagreeing with the disk.
 */

import { describe, expect, test } from "bun:test";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { FileEntry } from "@workspace/api";
import { renderToStaticMarkup } from "react-dom/server";
import { keys } from "@/api/keys";
import { ScopeTree } from "@/features/files/tree";

const nothing = () => undefined;

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

const markupFor = (listing: readonly FileEntry[]) => {
  const queryClient = new QueryClient();
  queryClient.setQueryData(keys.scopeListing("workspace", null), listing);
  return renderToStaticMarkup(
    <QueryClientProvider client={queryClient}>
      <ScopeTree
        onSelect={nothing}
        scope={{ scope: "workspace" }}
        selected={null}
      />
    </QueryClientProvider>
  );
};

describe("ScopeTree", () => {
  test("an ordinary file is a row that opens", () => {
    const markup = markupFor([
      entryOf({ bytes: 40, ext: "md", name: "AGENTS.md", path: "AGENTS.md" }),
    ]);

    expect(markup).toContain("AGENTS.md");
    expect(markup).toContain("<button");
  });

  test("a name no request can carry is listed and cannot be opened", () => {
    const odd = `notes${String.fromCharCode(7)}.md`;
    const markup = markupFor([entryOf({ name: odd, path: odd })]);

    expect(markup).toContain("notes");
    expect(markup).not.toContain("<button");
  });

  test("a link out of the scope is marked as leaving it", () => {
    const markup = markupFor([
      entryOf({
        kind: "symlink",
        name: "escape",
        path: "escape",
        target: "../../etc",
        targetOutsideScope: true,
      }),
    ]);

    expect(markup).toContain("outside");
  });
});
