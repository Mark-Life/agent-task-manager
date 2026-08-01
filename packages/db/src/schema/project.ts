import type { ProjectId } from "@workspace/domain";
import { pgTable, text, uniqueIndex } from "drizzle-orm/pg-core";
import { mutableColumns } from "./columns";

/**
 * A group of tasks, optionally naming a repository. A project with no `repo_url`
 * is an ordinary project — a trip, a piece of writing, an area of life — and
 * that null is the entire workspace seam: a clone when a repo is named, a
 * scratch directory when it is not. Nothing else branches on what shape of work
 * a task is, which is why a task has no kind of its own.
 *
 * The redundant `(workspace_id, id)` unique index is the target of every
 * composite foreign key pointing here, which is what makes a child row that
 * names a different workspace impossible rather than merely unlikely.
 */
export const project = pgTable(
  "project",
  {
    ...mutableColumns<ProjectId>(),
    description: text("description"),
    name: text("name").notNull(),
    // The PR base. Null means whatever the clone's HEAD turns out to be.
    repoDefaultBranch: text("repo_default_branch"),
    repoUrl: text("repo_url"),
  },
  (t) => [uniqueIndex("project_workspace_id_id_uidx").on(t.workspaceId, t.id)]
);
