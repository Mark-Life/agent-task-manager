import { Cancel01Icon, SearchIcon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { useQuery } from "@tanstack/react-query";
import type { ProjectId } from "@workspace/domain";
import { Button } from "@workspace/ui/components/button";
import { Input } from "@workspace/ui/components/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@workspace/ui/components/select";
import {
  type ChangeEvent,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { projectsQuery } from "@/api/projects";

/** What the board is filtered to, and how to say it has changed. */
interface FiltersProps {
  readonly onProjectChange: (projectId: ProjectId | null) => void;
  readonly onQueryChange: (query: string) => void;
  readonly projectId: ProjectId | null;
  readonly query: string;
}

/** The unfiltered board, which is the state the screen opens in. */
const ALL_PROJECTS = { label: "All projects", value: null };

/**
 * The board's filters.
 *
 * A project, and free text over the cards themselves. Project and nothing
 * more structured: a task has no kind, no assignee and no labels, so anything
 * beyond the text search would be a control over a field that does not exist.
 * The search reads what the board already holds — the one read carries every
 * card — rather than asking the server, so an answer arrives with the
 * keystroke instead of a round trip. Both are handed up rather than held here,
 * because they belong in the URL: a filtered board is a link somebody can
 * send.
 *
 * One control at a time, on every width. The project filter has the row until
 * the search button is pressed; then the search takes it and the button becomes
 * the way back. Nobody reads a project and types a search in the same breath,
 * and the row this saves is worth more than the second control — on a phone it
 * is most of what the board has to spend, and on a desktop it is the same
 * gesture rather than a second one to learn. Closing clears the text, so the
 * board is never narrowed by a filter that is not on screen; the project
 * survives underneath, because it is in the URL rather than in the control.
 */
export const BoardFilters = ({
  onProjectChange,
  onQueryChange,
  projectId,
  query,
}: FiltersProps) => {
  const projects = useQuery(projectsQuery());
  const [searching, setSearching] = useState(query !== "");
  const searchRef = useRef<HTMLInputElement>(null);

  const type = useCallback(
    (event: ChangeEvent<HTMLInputElement>) => onQueryChange(event.target.value),
    [onQueryChange]
  );
  const openSearch = useCallback(() => setSearching(true), []);
  const closeSearch = useCallback(() => {
    setSearching(false);
    onQueryChange("");
  }, [onQueryChange]);

  // The button is gone by the time the field is drawn, so the focus has to be
  // put back by hand or it lands on the document.
  useEffect(() => {
    if (searching) {
      searchRef.current?.focus();
    }
  }, [searching]);

  const items = useMemo(
    () => [
      ALL_PROJECTS,
      ...(projects.data ?? []).map((project) => ({
        label: project.name,
        value: project.id,
      })),
    ],
    [projects.data]
  );

  if (searching) {
    return (
      <div className="flex min-w-0 flex-1 items-center gap-2">
        <div className="relative min-w-0 flex-1 md:w-56 md:flex-none">
          <HugeiconsIcon
            className="pointer-events-none absolute top-1/2 left-2 size-3.5 -translate-y-1/2 text-muted-foreground"
            icon={SearchIcon}
            strokeWidth={2}
          />
          <Input
            aria-label="Search tasks"
            className="w-full pl-7"
            onChange={type}
            placeholder="Search tasks"
            ref={searchRef}
            type="search"
            value={query}
          />
        </div>
        <Button
          aria-label="Close search"
          className="shrink-0"
          onClick={closeSearch}
          size="icon"
          variant="ghost"
        >
          <HugeiconsIcon icon={Cancel01Icon} strokeWidth={2} />
        </Button>
      </div>
    );
  }

  return (
    <div className="flex min-w-0 flex-1 items-center gap-2">
      <Select items={items} onValueChange={onProjectChange} value={projectId}>
        <SelectTrigger
          aria-label="Filter by project"
          className="min-w-0 flex-1 md:w-44 md:flex-none"
        >
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          {items.map((item) => (
            <SelectItem key={item.value ?? "all"} value={item.value}>
              {item.label}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
      <Button
        aria-label="Search tasks"
        className="shrink-0"
        onClick={openSearch}
        size="icon"
        variant="outline"
      >
        <HugeiconsIcon icon={SearchIcon} strokeWidth={2} />
      </Button>
    </div>
  );
};
