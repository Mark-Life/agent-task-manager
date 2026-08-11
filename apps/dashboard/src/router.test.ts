/**
 * Proves the tree still assembles, that its pages are still fetched on demand,
 * and that every module behind one can actually be evaluated.
 *
 * Each screen is a dynamic import now, which moves a class of mistake out of the
 * build and into the moment somebody opens the page: a module that throws on
 * evaluation builds perfectly and fails only on arrival. Two of the screens
 * import the route they hang off, a cycle that is safe *because* the import is
 * dynamic — if that ever stops being true, it stops being true here.
 *
 * The imports below are deliberately not routed through `lazyRouteComponent`.
 * Its `preload` swallows whatever the import threw and keeps it for the render,
 * so a test that awaited it would pass on a module that cannot load at all.
 * These import the modules outright, where a throw is a throw. What ties each
 * one to the route that names it is the compiler: the route's specifier and the
 * export it asks for are both checked, so a screen this file loads and a screen
 * the router loads cannot drift apart without `bun run typecheck` saying so.
 */

import { describe, expect, test } from "bun:test";
import { router } from "@/router";

/** Every address the app answers on, which is what a route's `id` spells. */
const ROUTE_IDS = [
  "__root__",
  "/login",
  "/authenticated",
  "/authenticated/",
  "/authenticated/api-keys",
  "/authenticated/files",
  "/authenticated/projects",
  "/authenticated/tasks/$taskId",
] as const;

/**
 * The two that render eagerly: the root, and the frame every authenticated
 * screen arrives inside. Neither is a page somebody navigates to on its own, so
 * there is nothing about either to defer.
 */
const EAGER_IDS: readonly string[] = ["__root__", "/authenticated"];

/** Ids compared as text, so the two sides of an assertion line up the same way. */
const byName = (a: string, b: string) => a.localeCompare(b);

const routes = Object.values(router.routesById) as {
  readonly id: string;
  readonly options: {
    readonly component?: { readonly preload?: () => Promise<unknown> };
  };
}[];

describe("the route tree", () => {
  test("holds every address and no others", () => {
    expect(routes.map((route) => route.id).sort(byName)).toEqual(
      [...ROUTE_IDS].sort(byName)
    );
  });

  test("fetches every page on demand rather than up front", () => {
    const deferred = routes
      .filter((route) => route.options.component?.preload !== undefined)
      .map((route) => route.id)
      .sort(byName);

    expect(deferred).toEqual(
      ROUTE_IDS.filter((id) => !EAGER_IDS.includes(id)).sort(byName)
    );
  });
});

/**
 * Every module that is fetched rather than shipped: the six pages, and the
 * three panels that are mounted closed on screens the operator is already on.
 * One test each rather than a loop over a list, so a module that throws names
 * the screen a reader would have to open to see it.
 */
describe("each deferred screen loads", () => {
  test("the board", async () => {
    expect((await import("@/routes/board.screen")).BoardScreen).toBeDefined();
  });

  test("the task page", async () => {
    expect((await import("@/routes/task.screen")).TaskScreen).toBeDefined();
  });

  test("the file browser", async () => {
    expect((await import("@/routes/files.screen")).FilesScreen).toBeDefined();
  });

  test("the project list", async () => {
    expect(
      (await import("@/features/projects/projects")).Projects
    ).toBeDefined();
  });

  test("the key list", async () => {
    expect(
      (await import("@/features/api-keys/api-keys")).ApiKeys
    ).toBeDefined();
  });

  test("the sign-in form", async () => {
    expect((await import("@/features/auth/sign-in")).SignIn).toBeDefined();
  });
});

describe("each on-demand panel loads", () => {
  test("the task body behind the board's overlay", async () => {
    expect(
      (await import("@/features/task/detail")).TaskDetailView
    ).toBeDefined();
  });

  test("the conversation behind the chat overlay", async () => {
    expect(
      (await import("@/features/chat/conversation")).Conversation
    ).toBeDefined();
  });

  test("the workspace picker's select", async () => {
    expect(
      (await import("@/auth/workspace-select")).WorkspaceSelect
    ).toBeDefined();
  });

  test("the toaster", async () => {
    expect(
      (await import("@workspace/ui/components/sonner")).Toaster
    ).toBeDefined();
  });
});
