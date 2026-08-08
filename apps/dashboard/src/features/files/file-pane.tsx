import {
  ArrowLeft01Icon,
  Folder01Icon,
  Link01Icon,
} from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { useQuery } from "@tanstack/react-query";
import type { FileEntry } from "@workspace/api";
import type { FileScope, ScopePath } from "@workspace/domain";
import { Button } from "@workspace/ui/components/button";
import { useCallback } from "react";
import { scopeListingQuery } from "@/api/files";
import { EmptyState } from "@/components/empty-state";
import { Failed, Pending } from "@/components/query-state";
import { ScopeFileEditor } from "@/features/files/editor";
import { DeleteEntry, RenameEntry } from "@/features/files/entry-actions";
import { SCOPE_NOTES } from "@/features/files/scopes";
import { useScopeEntry } from "@/features/files/selection";
import { formatBytes, formatRelative } from "@/lib/format";
import { parentOf, resolveLinkTarget } from "@/lib/scope-path";

interface LinkPaneProps {
  readonly entry: FileEntry;
  readonly onSelect: (path: ScopePath) => void;
  readonly path: ScopePath;
}

/**
 * A symlink, said as a symlink.
 *
 * Never followed on this screen's own initiative. A link is one of the two
 * things a scope's layout is made of — a skill is real files plus a relative
 * link at the other CLI's path — and it is also the shape an untrusted run
 * plants to make the gateway read something outside the tree. So the target is
 * shown as it is stored, and the way through is offered only when it lands back
 * inside the same scope. Editing is not offered at all: a write here refuses to
 * follow a link, deliberately, and a save button that always failed would be a
 * lie.
 */
const LinkPane = ({ entry, onSelect, path }: LinkPaneProps) => {
  const target = entry.target ?? "";
  const inside = entry.targetOutsideScope
    ? null
    : resolveLinkTarget(parentOf(path), target);

  const follow = useCallback(() => {
    if (inside !== null) {
      onSelect(inside);
    }
  }, [inside, onSelect]);

  return (
    <div className="flex flex-col gap-3 p-4">
      <p className="text-muted-foreground text-xs">
        A link, not a copy. It points at
      </p>
      <p className="break-all rounded-md border bg-muted/30 px-3 py-2 font-mono text-xs">
        {target === "" ? "nothing this listing could read" : target}
      </p>

      {entry.targetOutsideScope ? (
        <p className="text-destructive text-xs">
          That leaves this scope. Every route here refuses to follow it, so
          nothing can read or write through this link — deleting it removes the
          link and leaves whatever it points at alone.
        </p>
      ) : null}

      {inside === null ? null : (
        <Button
          className="self-start"
          onClick={follow}
          size="sm"
          variant="outline"
        >
          <HugeiconsIcon icon={Link01Icon} strokeWidth={2} />
          Open {inside}
        </Button>
      )}
    </div>
  );
};

interface DirectoryPaneProps {
  readonly path: ScopePath;
  readonly scope: FileScope;
}

/** What a folder holds, counted. Enough to tell an empty mount point from a folder somebody filled. */
const DirectoryPane = ({ path, scope }: DirectoryPaneProps) => {
  const listing = useQuery(scopeListingQuery(scope, path));

  if (listing.isPending) {
    return <Pending className="p-4" label="Loading folder" lines={2} />;
  }

  if (listing.isError) {
    return (
      <Failed
        className="m-4"
        error={listing.error}
        onRetry={listing.refetch}
        title="That folder did not open"
      />
    );
  }

  return (
    <p className="p-4 text-muted-foreground text-xs">
      {listing.data.length === 0
        ? "This folder is empty. A run is given it and finds nothing in it."
        : `${listing.data.length} entries. Open one from the tree, or add to this folder from the buttons above it.`}
    </p>
  );
};

interface FilePaneProps {
  /** Null clears the selection, which is what a delete leaves behind at the root. */
  readonly onSelect: (path: ScopePath | null) => void;
  readonly path: ScopePath | null;
  readonly scope: FileScope;
}

/**
 * Whatever is selected, drawn as the kind of thing it is.
 *
 * The entry comes out of the parent directory's listing rather than from a call
 * of its own: the tree has already read that folder, so the kind, the size, the
 * modified time and a link's target are all in the cache by the time somebody
 * clicks. It also means this pane knows a path is a symlink *before* it reads
 * anything through it, which is what lets a link out of the scope be marked
 * instead of opened.
 */
export const FilePane = ({ onSelect, path, scope }: FilePaneProps) => {
  const { entry, isPending } = useScopeEntry(scope, path);

  // On a phone the tree and this pane share the width, so one of them is always
  // hidden — and the way back to the tree is dropping the selection, which is
  // also what the URL says.
  const clearSelection = useCallback(() => onSelect(null), [onSelect]);

  if (path === null) {
    return (
      <EmptyState
        className="m-4"
        description={SCOPE_NOTES[scope.scope]}
        icon={Folder01Icon}
        title="Nothing open"
      />
    );
  }

  if (isPending) {
    return <Pending className="p-4" label="Loading file" lines={4} />;
  }

  if (entry === undefined) {
    return (
      <EmptyState
        className="m-4"
        description="Nothing is at that path in this scope. It may have been renamed, or removed by a run."
        icon={Folder01Icon}
        title="Not here"
      />
    );
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <header className="flex shrink-0 items-start gap-2 border-border border-b p-3">
        <Button
          aria-label="Back to the tree"
          className="md:hidden"
          onClick={clearSelection}
          size="icon-sm"
          variant="ghost"
        >
          <HugeiconsIcon icon={ArrowLeft01Icon} strokeWidth={2} />
        </Button>
        <div className="flex min-w-0 flex-1 flex-col gap-0.5">
          <p className="truncate font-medium font-mono text-sm" title={path}>
            {path}
          </p>
          <p className="flex flex-wrap items-center gap-2 text-muted-foreground text-xs">
            <span>{entry.kind}</span>
            {entry.bytes === null ? null : (
              <span>{formatBytes(entry.bytes)}</span>
            )}
            {entry.modifiedAt === null ? null : (
              <span>{formatRelative(entry.modifiedAt)}</span>
            )}
          </p>
        </div>
        <div className="flex shrink-0 items-center gap-1">
          <RenameEntry
            entry={entry}
            onMoved={onSelect}
            path={path}
            scope={scope}
          />
          <DeleteEntry
            entry={entry}
            onMoved={onSelect}
            path={path}
            scope={scope}
          />
        </div>
      </header>

      {entry.kind === "symlink" ? (
        <LinkPane entry={entry} onSelect={onSelect} path={path} />
      ) : null}
      {entry.kind === "directory" ? (
        <DirectoryPane path={path} scope={scope} />
      ) : null}
      {entry.kind === "file" ? (
        <ScopeFileEditor key={path} path={path} scope={scope} />
      ) : null}
    </div>
  );
};
