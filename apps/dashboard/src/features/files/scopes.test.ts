/**
 * The picker is where a person decides who a rule reaches, so the address it
 * produces has to be the directory they chose.
 *
 * An option pointing at the wrong scope is the failure worth a test: it writes
 * house rules into one task's folder, where nothing reads them, or a task's
 * notes into the workspace, where every run does.
 */

import { describe, expect, test } from "bun:test";
import type { Project, Task } from "@workspace/api";
import { DateTime } from "effect";
import {
  scopeGroupsOf,
  scopeKeepsHistory,
  scopeLabelOf,
} from "@/features/files/scopes";

const AT = DateTime.makeUnsafe("2026-08-08T09:00:00.000Z");

const project = {
  createdAt: AT,
  id: "6f1a0b4e-0000-4000-8000-000000000001",
  name: "Gateway",
  repoUrl: null,
  updatedAt: AT,
} as unknown as Project;

const task = {
  createdAt: AT,
  id: "6f1a0b4e-0000-4000-8000-000000000002",
  title: "Fix the board filter",
  updatedAt: AT,
} as unknown as Task;

describe("scopeGroupsOf", () => {
  test("an empty workspace still offers the two scopes that always exist", () => {
    const groups = scopeGroupsOf({ projects: [], tasks: [] });

    expect(groups).toHaveLength(1);
    expect(groups[0]?.options.map((option) => option.address)).toEqual([
      "workspace",
      "manager",
    ]);
  });

  test("a project and a task each address their own directory by id", () => {
    const groups = scopeGroupsOf({ projects: [project], tasks: [task] });

    expect(groups.map((group) => group.heading)).toEqual([
      "Shared",
      "Projects",
      "Tasks",
    ]);
    expect(groups[1]?.options[0]).toEqual({
      address: `project:${project.id}`,
      label: "Gateway",
    });
    expect(groups[2]?.options[0]).toEqual({
      address: `task:${task.id}`,
      label: "Fix the board filter",
    });
  });

  test("a heading is never drawn over nothing", () => {
    const groups = scopeGroupsOf({ projects: [project], tasks: [] });

    expect(groups.map((group) => group.heading)).toEqual([
      "Shared",
      "Projects",
    ]);
  });
});

describe("scopeLabelOf", () => {
  test("a scope nobody can name is named by its address rather than by nothing", () => {
    const groups = scopeGroupsOf({ projects: [], tasks: [] });

    expect(
      scopeLabelOf("task:6f1a0b4e-0000-4000-8000-0000000000ff", groups)
    ).toBe("task:6f1a0b4e-0000-4000-8000-0000000000ff");
  });
});

describe("scopeKeepsHistory", () => {
  /**
   * The shared directories are git repositories snapshotted around every run,
   * so an edit there is recoverable. A task folder is not, and the editor says
   * so before somebody saves over a run's only output.
   */
  test("only a task's own folder keeps nothing behind an edit", () => {
    expect(scopeKeepsHistory({ scope: "workspace" })).toBe(true);
    expect(scopeKeepsHistory({ scope: "manager" })).toBe(true);
    expect(scopeKeepsHistory({ projectId: project.id, scope: "project" })).toBe(
      true
    );
    expect(scopeKeepsHistory({ scope: "task", taskId: task.id })).toBe(false);
  });
});
