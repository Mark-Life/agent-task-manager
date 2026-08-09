/**
 * The two things this panel must not get wrong.
 *
 * A proposal is a run asking for a change to a directory it was not allowed to
 * write, and accepting one writes bytes that every later run is then given. So
 * the target has to be the directory the row names — an address computed wrongly
 * would put one task's request into the house rules — and a request that is
 * still waiting must not be buried under answered ones, because nothing else in
 * the system will ever resolve it.
 *
 * Rendered to static markup rather than through a browser: what is being
 * checked is which elements exist for a given reading, and that is settled by
 * the tree.
 */

import { describe, expect, test } from "bun:test";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { Proposal } from "@workspace/api";
import { ProjectId, TaskId } from "@workspace/domain";
import { DateTime } from "effect";
import { renderToStaticMarkup } from "react-dom/server";
import { keys } from "@/api/keys";
import { proposalTargetOf } from "@/api/proposals";
import { pendingFirst, TaskProposals } from "@/features/task/proposals";

const AT = DateTime.makeUnsafe("2026-08-08T09:00:00.000Z");
const TASK_ID = TaskId.make("6f1a0b4e-0000-4000-8000-0000000000aa");
const PROJECT_ID = ProjectId.make("6f1a0b4e-0000-4000-8000-0000000000bb");

const proposalOf = (overrides: Partial<Proposal>) =>
  ({
    body: "# House rules\n\nWrite plainly.\n",
    contentHash: "sha256:0",
    createdAt: AT,
    decidedAt: null,
    decidedBy: null,
    id: "6f1a0b4e-0000-4000-8000-0000000000c1",
    path: "AGENTS.md",
    projectId: null,
    runId: null,
    scope: "workspace",
    sourcePath: ".atm/proposals/1.md",
    state: "pending",
    taskId: TASK_ID,
    updatedAt: AT,
    ...overrides,
  }) as unknown as Proposal;

describe("proposalTargetOf", () => {
  test("a workspace proposal points at the directory every run walks past", () => {
    expect(proposalTargetOf(proposalOf({}))).toEqual({ scope: "workspace" });
  });

  test("a project proposal carries the project whose folder it changes", () => {
    const target = proposalTargetOf(
      proposalOf({
        projectId: PROJECT_ID,
        scope: "project",
      } as Partial<Proposal>)
    );

    expect(target).toEqual({ projectId: PROJECT_ID, scope: "project" });
  });

  test("a project proposal with no project names no directory at all", () => {
    expect(
      proposalTargetOf(proposalOf({ projectId: null, scope: "project" }))
    ).toBeNull();
  });
});

describe("pendingFirst", () => {
  test("a request still waiting outranks every answer already given", () => {
    const answered = proposalOf({
      decidedAt: AT,
      id: "6f1a0b4e-0000-4000-8000-0000000000c2",
      state: "accepted",
    } as Partial<Proposal>);
    const waiting = proposalOf({});

    expect(pendingFirst([answered, waiting]).map((one) => one.state)).toEqual([
      "pending",
      "accepted",
    ]);
  });
});

const markupFor = (proposals: readonly Proposal[]) => {
  const queryClient = new QueryClient();
  queryClient.setQueryData(keys.proposals(TASK_ID), proposals);
  return renderToStaticMarkup(
    <QueryClientProvider client={queryClient}>
      <TaskProposals taskId={TASK_ID} />
    </QueryClientProvider>
  );
};

describe("TaskProposals", () => {
  test("a task nobody has asked anything of says so rather than drawing an empty list", () => {
    const markup = markupFor([]);

    expect(markup).toContain("Nothing to decide");
  });

  /**
   * A row naming a project it does not carry still lists, still shows what was
   * asked for, and offers nothing to press — the alternative is a proposal that
   * disappears, which is how a run's request goes unanswered forever. Decided,
   * so it also stands for the ordinary case: an answer already given leaves no
   * second one to give.
   */
  test("a row with no directory to write is shown and cannot be answered", () => {
    const markup = markupFor([
      proposalOf({
        decidedAt: AT,
        projectId: null,
        scope: "project",
        state: "rejected",
      } as Partial<Proposal>),
    ]);

    expect(markup).toContain("refused");
    expect(markup).toContain("cannot be resolved");
    expect(markup).not.toContain("Accept");
  });
});
