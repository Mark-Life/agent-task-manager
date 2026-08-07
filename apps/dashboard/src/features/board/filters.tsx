import { SearchIcon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { useQuery } from "@tanstack/react-query";
import type { ProjectId } from "@workspace/domain";
import { Input } from "@workspace/ui/components/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@workspace/ui/components/select";
import { type ChangeEvent, useCallback, useMemo } from "react";
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
 */
export const BoardFilters = ({
  onProjectChange,
  onQueryChange,
  projectId,
  query,
}: FiltersProps) => {
  const projects = useQuery(projectsQuery());
  const type = useCallback(
    (event: ChangeEvent<HTMLInputElement>) => onQueryChange(event.target.value),
    [onQueryChange]
  );
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

  return (
    <div className="flex items-center gap-2">
      <Select items={items} onValueChange={onProjectChange} value={projectId}>
        <SelectTrigger aria-label="Filter by project" className="w-44">
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
      <div className="relative">
        <HugeiconsIcon
          className="pointer-events-none absolute top-1/2 left-2 size-3.5 -translate-y-1/2 text-muted-foreground"
          icon={SearchIcon}
          strokeWidth={2}
        />
        <Input
          aria-label="Search tasks"
          className="w-56 pl-7"
          onChange={type}
          placeholder="Search tasks"
          type="search"
          value={query}
        />
      </div>
    </div>
  );
};
