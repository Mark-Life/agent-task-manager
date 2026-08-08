import { useQuery } from "@tanstack/react-query";
import type { FileEntry } from "@workspace/api";
import type { FileScope, ScopePath } from "@workspace/domain";
import { scopeListingQuery } from "@/api/files";
import { parentOf } from "@/lib/scope-path";

/**
 * What the selected path is, taken out of the listing of the folder above it.
 *
 * There is no route that describes one path, and there does not need to be: the
 * tree has already read the parent folder, so the kind, the size, the modified
 * time and a link's target are all in the cache by the time somebody clicks a
 * row. It also means a path is known to be a symlink *before* anything is read
 * through it, which is what lets a link out of the scope be marked rather than
 * opened.
 *
 * Undefined once the read has finished and nothing at that path was in it —
 * a file a run removed between the link being sent and the link being opened.
 */
export const useScopeEntry = (scope: FileScope, path: ScopePath | null) => {
  const listing = useQuery(
    scopeListingQuery(scope, path === null ? null : parentOf(path))
  );

  return {
    entry: listing.data?.find((candidate) => candidate.path === path),
    isPending: listing.isPending,
  };
};

/**
 * The folder something new should land in.
 *
 * A selected folder means inside it; a selected file means beside it. Reading a
 * person's selection as "where I am" is what makes "new file" one gesture
 * rather than a path typed out from the scope's root every time.
 */
export const directoryOf = (
  path: ScopePath | null,
  entry: FileEntry | undefined
) => {
  if (path === null) {
    return null;
  }
  return entry?.kind === "directory" ? path : parentOf(path);
};
