/**
 * The one thing about these two fields that must never regress: the way into an
 * edit has to be on the screen. It used to be a pencil inside the prose that
 * only appeared on hover, which meant a phone had no way to change a brief at
 * all — and a control that renders but is transparent looks identical to a
 * working one in every screenshot taken with a mouse.
 *
 * Rendered to static markup rather than through a browser: what is being
 * checked is that the button exists and that nothing in the field gates it on
 * hover, and both are settled by the tree.
 */

import { describe, expect, test } from "bun:test";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { Task } from "@workspace/api";
import { renderToStaticMarkup } from "react-dom/server";
import { TaskBrief } from "@/features/task/brief";

const taskWith = (fields: Partial<Task>) =>
  ({
    acceptance: "It works on a phone.",
    brief: "Something to read.",
    id: "019fe2b1-6e65-7c8f-beca-de7751e163a7",
    metadata: {},
    ...fields,
  }) as Task;

const markupFor = (task: Task) =>
  renderToStaticMarkup(
    <QueryClientProvider client={new QueryClient()}>
      <TaskBrief task={task} />
    </QueryClientProvider>
  );

describe("TaskBrief", () => {
  test("both headers carry a way into an edit", () => {
    const markup = markupFor(taskWith({}));

    expect(markup).toContain('aria-label="Edit brief"');
    expect(markup).toContain('aria-label="Edit acceptance criteria"');
  });

  test("nothing in the fields waits for a hover to become visible", () => {
    const markup = markupFor(taskWith({}));

    expect(markup).not.toContain("opacity-0");
    expect(markup).not.toContain("group-hover");
  });

  test("an empty field still offers the header control, not only its own row", () => {
    const markup = markupFor(taskWith({ acceptance: null, brief: "" }));

    expect(markup).toContain('aria-label="Edit brief"');
    expect(markup).toContain('aria-label="Edit acceptance criteria"');
    expect(markup).toContain("Add a brief");
  });
});
