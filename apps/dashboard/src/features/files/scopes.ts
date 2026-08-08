/**
 * The four directories of the agent filesystem, as something a person can pick
 * from a list.
 *
 * A run is handed a nested tree and reads its instructions by walking up it, so
 * which level a file sits at decides who is given it: house rules reach every
 * run of both roles, a project's reach every run on that project, a task's
 * reach one. The picker is where that choice is made, which is why each option
 * carries a sentence about who reads it rather than only a name — the directory
 * names alone would leave a person guessing whether a rule they are about to
 * write lands on one task or on everything.
 *
 * Two of the four are singletons and two need the row they belong to, so the
 * list is built from the projects and tasks already in the cache. Nothing here
 * fetches: a screen that has the lists hands them over, and one that does not
 * still gets the two shared scopes.
 */

import type { Project, Task } from "@workspace/api";
import type { FileScope, FileScopeKind } from "@workspace/domain";
import { fileScopeAddressOf } from "@workspace/domain";

/** Where the browser opens when the URL names no scope: the rules every run walks past. */
export const DEFAULT_SCOPE: FileScope = { scope: "workspace" };

/**
 * What each level is for, said as who reads it.
 *
 * The workspace scope is read-only to a worker and writable by the manager, and
 * that asymmetry is the one fact a person editing here most needs: a worker
 * clones arbitrary repositories, so the mount flag is what stops a hostile
 * README from rewriting the rules every later run is given.
 */
export const SCOPE_NOTES: Record<FileScopeKind, string> = {
  manager: "The chat role's own rules. A worker is never in this directory.",
  project:
    "Conventions and durable notes for one project. Every run on it reads and writes here.",
  task: "One task's own folder: what its runs wrote, and the proposals they raised.",
  workspace:
    "House rules, read by every run of both roles. A worker has this read-only; the manager can write it.",
};

/**
 * Who is handed a skill installed at each level, said as the people and the runs
 * rather than as a directory.
 *
 * Read where the scope is chosen, because choosing the scope *is* choosing the
 * audience and nothing else on the screen says so. A skill dropped into the
 * workspace folder because it was the folder that happened to be open reaches
 * every run of every project, which is not a thing anybody would do on purpose.
 */
export const SCOPE_AUDIENCE: Record<FileScopeKind, string> = {
  manager:
    "Installed here, a skill reaches the chat role only — a worker run is never in this directory.",
  project:
    "Installed here, a skill reaches every worker on this project, on every task in it.",
  task: "Installed here, a skill reaches this task's runs and nothing else.",
  workspace:
    "Installed here, a skill reaches every agent in this workspace: both roles, every project.",
};

/**
 * Which provider actually loads a skill from these directories, and how.
 *
 * Two different mechanisms, and the difference is worth a sentence: Codex reads
 * `.agents/skills` at every level of a run's tree directly, while Claude only
 * scans one directory whatever its working directory is — so each run is handed
 * a composed copy at that path instead. A person installing a skill should know
 * which of those they are relying on.
 */
export const SKILL_REACH =
  "Codex runs read these directly, at every level of the tree. Claude scans one directory whatever its working directory is, so each run is given a copy of these composed into it — a skill named at two levels resolves to the narrower one.";

/** Whether edits to a scope are kept anywhere but the file itself. */
export const scopeKeepsHistory = (scope: FileScope) => scope.scope !== "task";

/** What each level is called in a tally that reads as the tree. */
export const SCOPE_LEVELS: Record<FileScopeKind, string> = {
  manager: "Manager",
  project: "Project",
  task: "Task",
  workspace: "Workspace",
};

/**
 * The scopes one run walks for its instructions, shallowest first.
 *
 * This is the list a combined budget is added up over. A run reads instruction
 * files from the top of its tree down to its working directory, so which
 * directories those are depends on the role and on what the task belongs to: a
 * manager turn walks the workspace and its own folder, a worker on a task walks
 * the workspace, that task's project if it has one, and the task.
 *
 * Derived from the tasks already in the cache rather than fetched. A task whose
 * row has not arrived resolves to the pair that is certain — a tally missing a
 * project reads low, and reading low is the failure this whole measurement
 * exists to prevent, so the caller is told the list is short by its length.
 */
export const instructionChainOf = ({
  scope,
  tasks,
}: {
  readonly scope: FileScope;
  readonly tasks: readonly Task[];
}): readonly FileScope[] => {
  const workspace: FileScope = { scope: "workspace" };
  if (scope.scope === "workspace") {
    return [workspace];
  }
  if (scope.scope === "task") {
    const projectId = tasks.find((task) => task.id === scope.taskId)?.projectId;
    return projectId === undefined || projectId === null
      ? [workspace, scope]
      : [workspace, { projectId, scope: "project" }, scope];
  }
  return [workspace, scope];
};

/** One directory, named and addressed. */
export interface ScopeOption {
  /** The single URL segment that names it: `workspace`, `project:<id>`. */
  readonly address: string;
  readonly label: string;
}

/** A run of options under one heading, so the list reads as the tree rather than as a flat set. */
export interface ScopeGroup {
  readonly heading: string;
  readonly options: readonly ScopeOption[];
}

/** The two scopes that exist whether or not anything has been filed yet. */
const SHARED: readonly ScopeOption[] = [
  { address: fileScopeAddressOf({ scope: "workspace" }), label: "Workspace" },
  { address: fileScopeAddressOf({ scope: "manager" }), label: "Manager" },
];

interface ScopeSources {
  readonly projects: readonly Project[];
  readonly tasks: readonly Task[];
}

/**
 * Every directory a person can open, grouped.
 *
 * The shared pair comes first and is always there. A group with nothing in it
 * is left out rather than drawn empty: a heading over no rows says a project
 * exists whose folder could not be listed, which is not what an empty workspace
 * means.
 */
export const scopeGroupsOf = ({
  projects,
  tasks,
}: ScopeSources): readonly ScopeGroup[] => {
  const groups: ScopeGroup[] = [{ heading: "Shared", options: SHARED }];

  if (projects.length > 0) {
    groups.push({
      heading: "Projects",
      options: projects.map((project) => ({
        address: fileScopeAddressOf({
          projectId: project.id,
          scope: "project",
        }),
        label: project.name,
      })),
    });
  }

  if (tasks.length > 0) {
    groups.push({
      heading: "Tasks",
      options: tasks.map((task) => ({
        address: fileScopeAddressOf({ scope: "task", taskId: task.id }),
        label: task.title,
      })),
    });
  }

  return groups;
};

/** Every option in one sequence, which is what a select needs to render a chosen value. */
export const scopeOptionsOf = (groups: readonly ScopeGroup[]) =>
  groups.flatMap((group) => group.options);

/**
 * What to call the scope on screen.
 *
 * The address as a fallback rather than an empty header: a task deleted while
 * its folder survives, or a link to a project this account cannot list, still
 * has a directory behind it, and naming it by its address is truer than naming
 * it nothing.
 */
export const scopeLabelOf = (address: string, groups: readonly ScopeGroup[]) =>
  scopeOptionsOf(groups).find((option) => option.address === address)?.label ??
  address;
