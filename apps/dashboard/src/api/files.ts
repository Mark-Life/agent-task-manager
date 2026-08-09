import {
  type QueryClient,
  useMutation,
  useQueryClient,
} from "@tanstack/react-query";
import {
  type FileScope,
  fileScopeAddressOf,
  type ScopePath,
} from "@workspace/domain";
import { keys } from "@/api/keys";
import { apiMutation, apiQuery } from "@/api/query";

/** One path, in one scope: what every read and every write here names. */
export interface ScopeFileRef {
  readonly path: ScopePath;
  readonly scope: FileScope;
}

/** One file's whole text, going back into the scope it came out of. */
export interface ScopeFileSave extends ScopeFileRef {
  readonly content: string;
}

/**
 * A link and the file in the same scope it names.
 *
 * Two scope-relative paths and no link text: the server computes the text
 * between them and there is no field to put an absolute one in. A scope is a
 * bind mount, so a host path in a link would resolve on the screen that made it
 * and dangle in every container that reads the tree.
 */
export interface ScopeLinkCreate extends ScopeFileRef {
  readonly target: ScopePath;
}

/** A rename, inside one scope. Both ends are scope-relative because a move between scopes is a promotion, which copies and records who chose to. */
export interface ScopeFileMove {
  readonly from: ScopePath;
  readonly scope: FileScope;
  readonly to: ScopePath;
}

/**
 * What is in one directory, or in the scope's own root when no path is given.
 *
 * Directories first and then by name, which is the order the server answers in
 * — so a tree renders what it is handed and sorts nothing. The listing is the
 * disk at the moment somebody asked rather than an index of it, which is why a
 * symlink a run planted appears here as a symlink and not as the thing it
 * points at.
 */
export const scopeListingQuery = (
  scope: FileScope,
  path: ScopePath | null = null
) =>
  apiQuery(keys.scopeListing(fileScopeAddressOf(scope), path), (client) =>
    client.files.list({
      params: { scope },
      query: path === null ? {} : { path },
    })
  );

/**
 * One file's bytes, fetched only when somebody opens it.
 *
 * The answer says which encoding it survived: anything that did not decode as
 * text comes back base64, and the editor refuses it rather than showing
 * replacement characters somebody could save back over a real file.
 */
export const scopeFileQuery = (ref: ScopeFileRef) =>
  apiQuery(keys.scopeFile(fileScopeAddressOf(ref.scope), ref.path), (client) =>
    client.files.read({
      params: { scope: ref.scope },
      query: { path: ref.path },
    })
  );

/**
 * The whole scope, not the one path that changed.
 *
 * Every write here can create the directories above it, a move empties one
 * folder and fills another, and a delete takes a subtree — so the cheap,
 * correct answer is to drop the scope. A tree left holding a directory the
 * server no longer has is worse than a refetch nobody notices.
 *
 * Shared with the skills calls, which are writes of the same files under a
 * different name and would otherwise carry a second spelling of this.
 */
export const refreshScope = (queryClient: QueryClient, scope: FileScope) =>
  queryClient.invalidateQueries({
    queryKey: keys.scope(fileScopeAddressOf(scope)),
  });

/**
 * Write a file, creating the directories above it, and commit it to the scope's
 * own history.
 *
 * The encoding is fixed at text and is not a parameter. A binary cannot survive
 * a textarea, so the pane never offers to edit one — and a write that let a
 * caller choose base64 would make the corrupting case reachable by a component
 * passing the wrong string.
 */
export const useWriteScopeFile = () => {
  const queryClient = useQueryClient();
  return useMutation({
    ...apiMutation((save: ScopeFileSave, client) =>
      client.files.write({
        params: { scope: save.scope },
        payload: { content: save.content, encoding: "utf8", path: save.path },
      })
    ),
    onSuccess: (_entry, save) => refreshScope(queryClient, save.scope),
  });
};

/**
 * Create a directory and its parents. Separate from a write because a skill —
 * real files under `.agents/skills/<name>`, a link beside them — is directories
 * before it is a file, and because "new folder" is a thing a person does.
 */
export const useCreateScopeDirectory = () => {
  const queryClient = useQueryClient();
  return useMutation({
    ...apiMutation((ref: ScopeFileRef, client) =>
      client.files.createDirectory({
        params: { scope: ref.scope },
        payload: { path: ref.path },
      })
    ),
    onSuccess: (_entry, ref) => refreshScope(queryClient, ref.scope),
  });
};

/**
 * Point one name at another file in the same scope.
 *
 * What it is for is one rule under two names: `AGENTS.md` holds the text and
 * `CLAUDE.md` links to it, because Claude does not read the first name and Codex
 * does not read the second. One file to edit, and no pair to keep in step by
 * hand. The other use is the skills layout, where real files under
 * `.agents/skills/<name>` are reached through a link at the path the other CLI
 * scans.
 *
 * Refused when something is already at the path, when the target is not there,
 * and when the target is itself a link — one hop, so a listing always says what
 * a name ends up at.
 */
export const useCreateScopeLink = () => {
  const queryClient = useQueryClient();
  return useMutation({
    ...apiMutation((link: ScopeLinkCreate, client) =>
      client.files.createLink({
        params: { scope: link.scope },
        payload: { path: link.path, target: link.target },
      })
    ),
    onSuccess: (_entry, link) => refreshScope(queryClient, link.scope),
  });
};

/** Rename a file or a directory. The destination must not exist: the server refuses to replace one silently. */
export const useMoveScopeFile = () => {
  const queryClient = useQueryClient();
  return useMutation({
    ...apiMutation((move: ScopeFileMove, client) =>
      client.files.move({
        params: { scope: move.scope },
        payload: { from: move.from, to: move.to },
      })
    ),
    onSuccess: (_entry, move) => refreshScope(queryClient, move.scope),
  });
};

/**
 * Remove a file, a link, or a directory and everything under it.
 *
 * The cached bytes go with it rather than waiting for a refetch that would 404:
 * a pane still holding a deleted file's text is a pane offering to save it back.
 */
export const useDeleteScopeFile = () => {
  const queryClient = useQueryClient();
  return useMutation({
    ...apiMutation((ref: ScopeFileRef, client) =>
      client.files.delete({
        params: { scope: ref.scope },
        query: { path: ref.path },
      })
    ),
    onSuccess: async (_deleted, ref) => {
      queryClient.removeQueries({
        queryKey: keys.scopeFile(fileScopeAddressOf(ref.scope), ref.path),
      });
      await refreshScope(queryClient, ref.scope);
    },
  });
};
