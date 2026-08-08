import { createRoute } from "@tanstack/react-router";
import type { ScopePath } from "@workspace/domain";
import { useCallback, useMemo } from "react";
import { RouteError } from "@/components/error-boundary";
import { FileBrowser } from "@/features/files/browser";
import { DEFAULT_SCOPE } from "@/features/files/scopes";
import { layoutRoute } from "@/routes/layout";
import {
  fileScopeOf,
  parseFileScopeAddress,
  parseScopePath,
} from "@/routes/search";

/**
 * Both halves of what is on screen, because both are things a person meant to
 * show somebody: the directory and the file inside it. Sending a link is how
 * one operator tells another which rule to change.
 */
export interface FilesSearch {
  readonly path?: ScopePath;
  readonly scope?: string;
}

/**
 * The scope stays the one segment a URL carries rather than the union it
 * decodes into: what goes back into the address bar is whatever the typed
 * search holds, and the union would put JSON where `project:<id>` belongs.
 */
const validateSearch = (search: Record<string, unknown>): FilesSearch => ({
  path: parseScopePath(search.path),
  scope: parseFileScopeAddress(search.scope),
});

/**
 * The file browser, opened on whatever the URL names.
 *
 * A scope this workspace could not have issued opens the house rules instead of
 * an error page — same as every other parameter here, a mangled link degrades
 * into the plain screen. Changing scope drops the path with it: a path is
 * relative to one directory, and carrying it across would ask for whatever
 * happened to share a name.
 */
const FilesScreen = () => {
  const { path, scope } = filesRoute.useSearch();
  const navigate = filesRoute.useNavigate();

  const openScope = useMemo(() => fileScopeOf(scope) ?? DEFAULT_SCOPE, [scope]);

  const selectScope = useCallback(
    (address: string) => {
      navigate({
        search: (previous) => ({
          ...previous,
          path: undefined,
          scope: address,
        }),
        to: ".",
      });
    },
    [navigate]
  );

  const selectPath = useCallback(
    (next: ScopePath | null) => {
      navigate({
        search: (previous) => ({ ...previous, path: next ?? undefined }),
        to: ".",
      });
    },
    [navigate]
  );

  return (
    <FileBrowser
      onSelectPath={selectPath}
      onSelectScope={selectScope}
      path={path ?? null}
      scope={openScope}
    />
  );
};

/**
 * The tree a run reads its rules from, on its own address.
 *
 * Its own page rather than a panel on the project screen: the workspace and the
 * manager scopes belong to no project, and the browsing is between scopes as
 * much as inside one.
 */
export const filesRoute = createRoute({
  component: FilesScreen,
  errorComponent: RouteError,
  getParentRoute: () => layoutRoute,
  path: "/files",
  validateSearch,
});
