/**
 * The agent filesystem, as a screen.
 *
 * A run is handed a nested tree of directories and reads its instructions by
 * walking up it. Those are ordinary folders on the host, and until this screen
 * existed the only ways into them were a promotion, a proposal somebody
 * confirmed over HTTP, and a run's own writes — which is to say there was no way
 * to fix a typo in the house rules without a deploy.
 *
 * **There is no terminal here, and there will not be one.** A shell on this page
 * runs as the loop process, which holds the GitHub token, the database
 * credentials and the agent-home logins. Six file operations are what a person
 * needs to keep a tree in order, and they are all this screen offers. If one is
 * ever wanted, the safe shape is a throwaway container with only the target
 * scope mounted, and it is an escape hatch rather than something that lives on a
 * page behind a session cookie.
 */

import { useQuery } from "@tanstack/react-query";
import type { FileScope, ScopePath } from "@workspace/domain";
import { fileScopeAddressOf } from "@workspace/domain";
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectLabel,
  SelectTrigger,
  SelectValue,
} from "@workspace/ui/components/select";
import { SidebarTrigger } from "@workspace/ui/components/sidebar";
import { cn } from "@workspace/ui/lib/utils";
import { useCallback, useMemo } from "react";
import { projectsQuery } from "@/api/projects";
import { tasksQuery } from "@/api/tasks";
import { FilePane } from "@/features/files/file-pane";
import { NewEntry } from "@/features/files/new-entry";
import {
  SCOPE_NOTES,
  scopeGroupsOf,
  scopeOptionsOf,
} from "@/features/files/scopes";
import { directoryOf, useScopeEntry } from "@/features/files/selection";
import { ScopeTree } from "@/features/files/tree";

interface BrowserProps {
  readonly onSelectPath: (path: ScopePath | null) => void;
  readonly onSelectScope: (address: string) => void;
  readonly path: ScopePath | null;
  readonly scope: FileScope;
}

/**
 * The tree on one side and the file on the other.
 *
 * Both halves are facts about the URL, so a link opens the same file in the
 * same scope for whoever receives it — which is the whole point of putting the
 * rules on a screen: the way to tell somebody what to change is to send them
 * the file.
 *
 * On a phone the two halves take turns rather than shrinking: a tree squeezed
 * beside an editor leaves neither usable, and the selection already says which
 * one the reader is looking at.
 */
export const FileBrowser = ({
  onSelectPath,
  onSelectScope,
  path,
  scope,
}: BrowserProps) => {
  const projects = useQuery(projectsQuery());
  const tasks = useQuery(tasksQuery());

  const groups = useMemo(
    () =>
      scopeGroupsOf({
        projects: projects.data ?? [],
        tasks: tasks.data ?? [],
      }),
    [projects.data, tasks.data]
  );
  const options = useMemo(() => scopeOptionsOf(groups), [groups]);

  const address = fileScopeAddressOf(scope);

  // The control's value can be cleared, and this list has nothing to clear to:
  // every scope in it is a directory that exists, and "no scope" is not a
  // screen. A null is the primitive's own empty state and is dropped here.
  const chooseScope = useCallback(
    (next: string | null) => {
      if (next !== null) {
        onSelectScope(next);
      }
    },
    [onSelectScope]
  );

  // New things land where the reader is: inside the selected folder, or beside
  // the selected file. The entry is already in the cache — the tree read the
  // folder above it to draw the row that was clicked.
  const { entry } = useScopeEntry(scope, path);
  const directory = directoryOf(path, entry);

  return (
    <div className="flex h-full min-h-0 min-w-0 flex-col">
      <header className="flex shrink-0 flex-wrap items-center gap-2 border-border border-b px-4 py-3">
        <SidebarTrigger className="md:hidden" />
        <Select
          items={options.map((option) => ({
            label: option.label,
            value: option.address,
          }))}
          onValueChange={chooseScope}
          value={address}
        >
          <SelectTrigger aria-label="Directory" className="w-56 min-w-0">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {groups.map((group) => (
              <SelectGroup key={group.heading}>
                <SelectLabel>{group.heading}</SelectLabel>
                {group.options.map((option) => (
                  <SelectItem key={option.address} value={option.address}>
                    {option.label}
                  </SelectItem>
                ))}
              </SelectGroup>
            ))}
          </SelectContent>
        </Select>

        <div className="flex items-center gap-2">
          <NewEntry
            directory={directory}
            kind="file"
            onCreated={onSelectPath}
            scope={scope}
          />
          <NewEntry
            directory={directory}
            kind="directory"
            onCreated={onSelectPath}
            scope={scope}
          />
        </div>

        <p className="w-full text-muted-foreground text-xs">
          {SCOPE_NOTES[scope.scope]}
        </p>
      </header>

      <div className="flex min-h-0 min-w-0 flex-1">
        <nav
          aria-label="Files in this scope"
          className={cn(
            "min-h-0 w-full shrink-0 overflow-y-auto border-border p-2 md:w-72 md:border-r",
            path === null ? null : "max-md:hidden"
          )}
        >
          {/*
            Keyed by the scope: which folders are open are paths inside one
            directory, and carrying them across a change of scope would open
            whatever happened to share a name.
          */}
          <ScopeTree
            key={address}
            onSelect={onSelectPath}
            scope={scope}
            selected={path}
          />
        </nav>

        <section
          className={cn(
            "flex min-h-0 min-w-0 flex-1 flex-col overflow-y-auto",
            path === null ? "max-md:hidden" : null
          )}
        >
          <FilePane onSelect={onSelectPath} path={path} scope={scope} />
        </section>
      </div>
    </div>
  );
};
