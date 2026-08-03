import { useQuery } from "@tanstack/react-query";
import type { ProjectId } from "@workspace/domain";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@workspace/ui/components/select";
import { useMemo } from "react";
import { projectsQuery } from "@/api/projects";

/** What the board is filtered to, and how to say it has changed. */
interface FiltersProps {
  readonly onProjectChange: (projectId: ProjectId | null) => void;
  readonly projectId: ProjectId | null;
}

/** The unfiltered board, which is the state the screen opens in. */
const ALL_PROJECTS = { label: "All projects", value: null };

/**
 * The board's only filter.
 *
 * Project and nothing else: a task has no kind, no assignee and no labels, so
 * anything more would be a control over a field that does not exist. The
 * selection is handed up rather than held here, because it belongs in the URL —
 * a filtered board is a link somebody can send.
 */
export const BoardFilters = ({ onProjectChange, projectId }: FiltersProps) => {
  const projects = useQuery(projectsQuery());
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
    <Select items={items} onValueChange={onProjectChange} value={projectId}>
      <SelectTrigger aria-label="Filter by project" className="w-44" size="sm">
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
  );
};
