import {
  ArrowDown01Icon,
  ArrowRight01Icon,
  File01Icon,
  Folder01Icon,
  Link01Icon,
} from "@hugeicons/core-free-icons";
import type { IconSvgElement } from "@hugeicons/react";
import { HugeiconsIcon } from "@hugeicons/react";
import { useQuery } from "@tanstack/react-query";
import type { FileEntry } from "@workspace/api";
import type { FileScope, ScopePath } from "@workspace/domain";
import { Skeleton } from "@workspace/ui/components/skeleton";
import { cn } from "@workspace/ui/lib/utils";
import { type ReactElement, useCallback, useState } from "react";
import { scopeListingQuery } from "@/api/files";
import { failureSentence } from "@/components/query-state";
import { ancestorsOf, scopePathOf } from "@/lib/scope-path";

/** The mark each kind of entry is recognised by, before its name is read. */
const KIND_ICONS: Record<FileEntry["kind"], IconSvgElement> = {
  directory: Folder01Icon,
  file: File01Icon,
  symlink: Link01Icon,
};

interface RowProps {
  readonly entry: FileEntry;
  readonly expanded: boolean;
  readonly onSelect: (path: ScopePath) => void;
  readonly onToggle: (path: string) => void;
  /** Null where the name on disk is one no route here can carry. */
  readonly path: ScopePath | null;
  readonly selected: boolean;
}

/**
 * One entry, as the thing it is on disk.
 *
 * A symlink is drawn as a symlink with its target beside it, never as the
 * directory it points at. The skills layout is one real folder under
 * `.agents/skills/<name>` and a link at `.claude/skills/<name>`, so a tree that
 * flattened the two would show one skill twice and give no way to tell which
 * copy an edit lands in. A link out of the scope is marked and left shut: every
 * route refuses to follow one, and a row that offered to open it would be
 * promising something the server will not do.
 *
 * A name this system cannot address — a control character in it, a backslash —
 * is drawn and cannot be clicked. Hiding the row would say the folder is empty
 * when it is not; letting it be clicked would send a request that is refused at
 * the edge with a message about schemas.
 */
const TreeRow = ({
  entry,
  expanded,
  onSelect,
  onToggle,
  path,
  selected,
}: RowProps) => {
  const isDirectory = entry.kind === "directory";

  const press = useCallback(() => {
    if (path === null) {
      return;
    }
    onSelect(path);
    if (isDirectory) {
      onToggle(path);
    }
  }, [isDirectory, onSelect, onToggle, path]);

  if (path === null) {
    return (
      <span
        className="flex w-full items-center gap-1.5 rounded-sm px-1.5 py-1 text-left text-muted-foreground text-xs"
        title="This name carries a character no request here can spell, so the file cannot be opened."
      >
        <span className="size-3.5 shrink-0" />
        <HugeiconsIcon
          className="size-3.5 shrink-0 opacity-50"
          icon={KIND_ICONS[entry.kind]}
          strokeWidth={2}
        />
        <span className="truncate line-through">{entry.name}</span>
      </span>
    );
  }

  return (
    <button
      className={cn(
        "flex w-full items-center gap-1.5 rounded-sm px-1.5 py-1 text-left text-xs hover:bg-muted",
        selected && "bg-muted font-medium"
      )}
      onClick={press}
      title={
        entry.target === null ? entry.path : `${entry.path} → ${entry.target}`
      }
      type="button"
    >
      {isDirectory ? (
        <HugeiconsIcon
          className="size-3.5 shrink-0 text-muted-foreground"
          icon={expanded ? ArrowDown01Icon : ArrowRight01Icon}
          strokeWidth={2}
        />
      ) : (
        <span className="size-3.5 shrink-0" />
      )}
      <HugeiconsIcon
        className="size-3.5 shrink-0 text-muted-foreground"
        icon={KIND_ICONS[entry.kind]}
        strokeWidth={2}
      />
      <span className="truncate font-mono">{entry.name}</span>
      {entry.targetOutsideScope ? (
        <span className="shrink-0 rounded-sm bg-destructive/10 px-1 text-[0.625rem] text-destructive">
          outside
        </span>
      ) : null}
    </button>
  );
};

interface DirectoryProps {
  readonly expanded: ReadonlySet<string>;
  readonly onSelect: (path: ScopePath) => void;
  readonly onToggle: (path: string) => void;
  /** Null is the scope's own root, which is named by leaving the path out. */
  readonly path: ScopePath | null;
  readonly scope: FileScope;
  readonly selected: ScopePath | null;
}

/**
 * One directory's rows, and the directories opened under them.
 *
 * A query per open folder rather than one recursive read of the whole scope: a
 * scope holds a vault and a checkout's worth of notes, and a tree that fetched
 * all of it to draw four rows would make opening the screen the slowest thing
 * in the app. Each folder is also then refetched on its own when something in
 * it changes.
 *
 * The return type is written out because the component draws itself. Inference
 * cannot close that loop, and the alternative — flattening the tree into one
 * list — would mean a hook per open folder in a loop, which React does not
 * allow.
 */
const Directory = ({
  expanded,
  onSelect,
  onToggle,
  path,
  scope,
  selected,
}: DirectoryProps): ReactElement => {
  const listing = useQuery(scopeListingQuery(scope, path));

  if (listing.isPending) {
    return <Skeleton className="my-1 ml-2 h-4 w-24" />;
  }

  if (listing.isError) {
    return (
      <p className="px-2 py-1 text-destructive text-xs">
        {failureSentence(listing.error)}
      </p>
    );
  }

  if (listing.data.length === 0) {
    return <p className="px-2 py-1 text-muted-foreground text-xs">Empty</p>;
  }

  return (
    <ul
      className={cn(
        "flex flex-col",
        path === null ? null : "ml-2 border-l pl-1"
      )}
    >
      {listing.data.map((entry) => {
        // Decoded once per row and handed to both halves: it decides whether
        // the row can be clicked and it is the only path a nested listing can
        // be read with.
        const entryPath = scopePathOf(entry.path);
        const open = entry.kind === "directory" && expanded.has(entry.path);

        return (
          <li key={entry.path}>
            <TreeRow
              entry={entry}
              expanded={open}
              onSelect={onSelect}
              onToggle={onToggle}
              path={entryPath}
              selected={selected === entry.path}
            />
            {open && entryPath !== null ? (
              <Directory
                expanded={expanded}
                onSelect={onSelect}
                onToggle={onToggle}
                path={entryPath}
                scope={scope}
                selected={selected}
              />
            ) : null}
          </li>
        );
      })}
    </ul>
  );
};

interface ScopeTreeProps {
  readonly onSelect: (path: ScopePath) => void;
  readonly scope: FileScope;
  readonly selected: ScopePath | null;
}

/**
 * One scope's directories, opened as far as the reader has asked for.
 *
 * Which folders are open is local state and not in the URL. What a link has to
 * carry is the file somebody meant to show, and the folders above it follow
 * from that — so a deep link expands its own ancestors and nothing else, rather
 * than restoring somebody else's browsing.
 *
 * Mount this keyed by the scope. Open folders are paths inside one directory,
 * and carrying them across a change of scope would open whatever happened to
 * share a name.
 */
export const ScopeTree = ({ onSelect, scope, selected }: ScopeTreeProps) => {
  const [expanded, setExpanded] = useState<ReadonlySet<string>>(
    () => new Set(selected === null ? [] : ancestorsOf(selected))
  );
  const [seeded, setSeeded] = useState(selected);

  // Seeded while rendering rather than in an effect, so a link opened onto a
  // nested file never draws one frame with the file's folders shut. Merged into
  // what is already open: following a link should not close what the reader
  // opened by hand.
  if (seeded !== selected) {
    setSeeded(selected);
    if (selected !== null) {
      setExpanded((open) => new Set([...open, ...ancestorsOf(selected)]));
    }
  }

  const toggle = useCallback((path: string) => {
    setExpanded((open) => {
      const next = new Set(open);
      if (!next.delete(path)) {
        next.add(path);
      }
      return next;
    });
  }, []);

  return (
    <Directory
      expanded={expanded}
      onSelect={onSelect}
      onToggle={toggle}
      path={null}
      scope={scope}
      selected={selected}
    />
  );
};
