/**
 * Skills, which are files in a scope rather than rows anywhere.
 *
 * Every one of these five calls ends in bytes on disk under
 * `<scope>/.agents/skills/<name>` with a link beside them, so each key hangs off
 * the scope the file browser reads — one invalidation refreshes the list of
 * skills and the tree they are written into, and a person who installs one can
 * open the `SKILL.md` a click later without a refetch anybody had to remember.
 *
 * The update is deliberately two calls. Checking asks the source what it holds
 * and answers with the difference; applying quotes the hash that was shown and
 * is refused if the repository moved in between. A single call would be an
 * update nobody read, and a diff nobody read is not a review — so there is no
 * hook here that does both.
 */

import { useMutation, useQueryClient } from "@tanstack/react-query";
import {
  type FileScope,
  fileScopeAddressOf,
  type SkillName,
} from "@workspace/domain";
import { refreshScope } from "@/api/files";
import { keys } from "@/api/keys";
import { apiMutation, apiQuery } from "@/api/query";
import type { ApiClientShape } from "@/api/runtime";

/** What installing one takes, named by the call rather than restated beside it. */
type SkillInstallPayload = Parameters<
  ApiClientShape["skills"]["install"]
>[0]["payload"];

/** One skill, in one scope: what every update and every removal names. */
export interface ScopeSkillRef {
  readonly name: SkillName;
  readonly scope: FileScope;
}

/** Installing into one scope: the source, and the directory it lands in. */
export interface ScopeSkillInstall {
  readonly install: SkillInstallPayload;
  readonly scope: FileScope;
}

/** Applying an update somebody has read, quoting the hash they read. */
export interface ScopeSkillApply extends ScopeSkillRef {
  readonly expectedHash: string;
}

/**
 * What one scope has installed, in name order.
 *
 * The lock checked against the disk, so a skill whose directory a person deleted
 * through the file routes lists with `present: false` rather than vanishing. A
 * skill written by hand has no lock row and is not here at all — it is in the
 * file browser, under the same two paths.
 */
export const scopeSkillsQuery = (scope: FileScope) =>
  apiQuery(keys.scopeSkills(fileScopeAddressOf(scope)), (client) =>
    client.skills.list({ params: { scope } })
  );

/**
 * What the source holds now, against what is installed.
 *
 * The one read in this app that leaves the machine for somebody else's server,
 * so it is fetched when a person opens the review and not before. Pair it with
 * `enabled`.
 */
export const skillUpdateQuery = (ref: ScopeSkillRef) =>
  apiQuery(
    keys.scopeSkillUpdate(fileScopeAddressOf(ref.scope), ref.name),
    (client) =>
      client.skills.checkUpdate({
        params: { name: ref.name, scope: ref.scope },
      })
  );

/**
 * Fetch a skill from GitHub and write it into the scope.
 *
 * The credential is the one this system already holds for cloning, so a private
 * repository the board can reach is a repository a skill can come from. A name
 * the lock already knows is replaced, which is what makes a failed install
 * repeatable; a directory no lock row claims is refused, because that is
 * somebody's hand-written skill.
 */
export const useInstallSkill = () => {
  const queryClient = useQueryClient();
  return useMutation({
    ...apiMutation((request: ScopeSkillInstall, client) =>
      client.skills.install({
        params: { scope: request.scope },
        payload: request.install,
      })
    ),
    onSuccess: (_skill, request) => refreshScope(queryClient, request.scope),
  });
};

/**
 * Write the update that was reviewed, naming the hash it was reviewed at.
 *
 * The source is fetched again and refused if it moved, so the bytes that land
 * are the bytes somebody looked at. Files the source no longer has are removed
 * with it — which is also what happens to an edit made to an installed skill by
 * hand.
 */
export const useApplySkillUpdate = () => {
  const queryClient = useQueryClient();
  return useMutation({
    ...apiMutation((request: ScopeSkillApply, client) =>
      client.skills.applyUpdate({
        params: { name: request.name, scope: request.scope },
        payload: { expectedHash: request.expectedHash },
      })
    ),
    onSuccess: (_skill, request) => refreshScope(queryClient, request.scope),
  });
};

/**
 * Remove a skill's directory, its link and its lock row together.
 *
 * Together is the point: deleting the folder in the file browser leaves a lock
 * row pointing at nothing and a dangling link beside it.
 */
export const useUninstallSkill = () => {
  const queryClient = useQueryClient();
  return useMutation({
    ...apiMutation((ref: ScopeSkillRef, client) =>
      client.skills.uninstall({ params: { name: ref.name, scope: ref.scope } })
    ),
    onSuccess: (_removed, ref) => refreshScope(queryClient, ref.scope),
  });
};
