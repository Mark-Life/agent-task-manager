import type { ScopePath } from "@workspace/domain";
import { useCallback, useMemo } from "react";
import { FileBrowser } from "@/features/files/browser";
import { DEFAULT_SCOPE } from "@/features/files/scopes";
import { filesRoute } from "@/routes/files";
import { fileScopeOf, type ScopeView } from "@/routes/search";

/**
 * The file browser, opened on whatever the URL names.
 *
 * A scope this workspace could not have issued opens the house rules instead of
 * an error page — same as every other parameter here, a mangled link degrades
 * into the plain screen. Changing scope drops the path with it: a path is
 * relative to one directory, and carrying it across would ask for whatever
 * happened to share a name.
 *
 * The route it hangs off is imported rather than named by id — see the note in
 * `board.screen.tsx` for why that is not the cycle it looks like.
 */
export const FilesScreen = () => {
  const { path, scope, view } = filesRoute.useSearch();
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

  const selectView = useCallback(
    (next: ScopeView) => {
      navigate({
        search: (previous) => ({ ...previous, view: next }),
        to: ".",
      });
    },
    [navigate]
  );

  return (
    <FileBrowser
      onSelectPath={selectPath}
      onSelectScope={selectScope}
      onSelectView={selectView}
      path={path ?? null}
      scope={openScope}
      view={view ?? "files"}
    />
  );
};
