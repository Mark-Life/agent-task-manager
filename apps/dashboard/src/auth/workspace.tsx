import { lazy, Suspense, useMemo } from "react";
import { authClient } from "@/auth/client";

/** Below this a workspace is implied by the membership, so nothing is asked. */
const AMBIGUOUS_FROM = 2;

/**
 * The control, fetched only by the accounts that can see it.
 *
 * The membership count is the whole condition, and it is known here without any
 * of the select's own weight — so the import is placed behind the same test
 * that decides whether anything is drawn at all.
 */
const WorkspaceSelect = lazy(() =>
  import("@/auth/workspace-select").then((module) => ({
    default: module.WorkspaceSelect,
  }))
);

/**
 * Which workspace the session speaks for.
 *
 * The gateway derives the workspace from the credential: with one membership it
 * takes that one and never consults this control, which is why the picker hides
 * itself rather than showing a select with a single option. The moment a second
 * membership exists, every request is refused as ambiguous until something
 * calls `setActive` — so this is the only door out of that state, and it has to
 * be here before the second workspace is.
 */
export const WorkspacePicker = () => {
  const workspaces = authClient.useListOrganizations();
  const active = authClient.useActiveOrganization();

  const items = useMemo(
    () =>
      (workspaces.data ?? []).map((workspace) => ({
        label: workspace.name,
        value: workspace.id,
      })),
    [workspaces.data]
  );

  if (items.length < AMBIGUOUS_FROM) {
    return null;
  }

  return (
    // Nothing stands in for the control while it arrives: the row it sits in is
    // empty until the memberships are read anyway, and a placeholder shaped like
    // a select would be a second thing appearing where one is about to.
    <Suspense fallback={null}>
      <WorkspaceSelect activeId={active.data?.id ?? null} items={items} />
    </Suspense>
  );
};
