import { createRoute, lazyRouteComponent } from "@tanstack/react-router";
import type { ScopePath } from "@workspace/domain";
import { RouteError } from "@/components/error-boundary";
import { layoutRoute } from "@/routes/layout";
import {
  parseFileScopeAddress,
  parseScopePath,
  parseScopeView,
  type ScopeView,
} from "@/routes/search";

/**
 * Everything on screen, because every part of it is something a person meant to
 * show somebody: the directory, the file inside it, and whether they are looking
 * at the tree or at what is installed. Sending a link is how one operator tells
 * another which rule to change.
 */
export interface FilesSearch {
  readonly path?: ScopePath;
  readonly scope?: string;
  readonly view?: ScopeView;
}

/**
 * The scope stays the one segment a URL carries rather than the union it
 * decodes into: what goes back into the address bar is whatever the typed
 * search holds, and the union would put JSON where `project:<id>` belongs.
 */
const parseFilesSearch = (search: Record<string, unknown>): FilesSearch => ({
  path: parseScopePath(search.path),
  scope: parseFileScopeAddress(search.scope),
  view: parseScopeView(search.view),
});

/**
 * The tree a run reads its rules from, on its own address.
 *
 * Its own page rather than a panel on the project screen: the workspace and the
 * manager scopes belong to no project, and the browsing is between scopes as
 * much as inside one.
 *
 * The browser itself — a tree, an editor, a skills panel — is fetched when
 * somebody opens it. Most sessions never do, and none of it is needed to know
 * that this path is a page.
 */
export const filesRoute = createRoute({
  component: lazyRouteComponent(
    () => import("@/routes/files.screen"),
    "FilesScreen"
  ),
  errorComponent: RouteError,
  getParentRoute: () => layoutRoute,
  path: "/files",
  validateSearch: parseFilesSearch,
});
