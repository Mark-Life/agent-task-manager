/**
 * Installing a skill into one directory of the agent filesystem, and keeping it
 * up to date.
 *
 * **A skill is installed by writing files.** There is no installer, no registry
 * client and no package manager: the real files land at
 * `<scope>/.agents/skills/<name>/`, a relative symbolic link at
 * `<scope>/.claude/skills/<name>` points at them, and a `skills-lock.json` at
 * the scope's root records where they came from. Everything these five
 * operations do is visible in the file routes afterwards, which is the property
 * worth having — a person who prefers to write a skill by hand gets the same
 * layout, and a person debugging one can read every byte of it.
 *
 * **Where they are read, and by which provider.** Codex collects
 * `.agents/skills` from every level of a run's tree, so a skill installed here
 * reaches a Codex run. Claude does not: its scan for project skills runs from
 * the working directory up to the repository root and stops, and the working
 * directory is the checkout, so every scope directory sits above that stop.
 * Claude keeps reading the operator's personal skills at `/agent-home/skills`
 * instead. A dashboard must say so rather than imply a skill installed here
 * changes what a Claude run can do.
 *
 * **Admin, like the file routes, and for the same two reasons.** A worker run
 * may not install or update a skill: that is one run editing what every later
 * run on the board is given, with no author and no review. The restriction is
 * about the run rather than about skills — a person installs whatever they like
 * — and an agent credential's ceiling is `task-write`, so admin is the way to
 * say "a person" that the token machinery enforces instead of a handler
 * remembering to.
 *
 * **An update is two calls, deliberately.** Checking re-fetches the source and
 * answers with what changed, file by file; applying quotes the hash that was
 * shown and is refused if the source has moved since. A single call that
 * fetched and wrote would be an update nobody read, and a diff nobody read is
 * not a review.
 */

import { FileScopeAddress, SkillName } from "@workspace/domain";
import { Schema } from "effect";
import {
  HttpApiEndpoint,
  HttpApiGroup,
  OpenApi,
} from "effect/unstable/httpapi";
import { Forbidden, InvalidInput, NotFound } from "../errors";
import {
  InstalledSkill,
  SkillInstall,
  SkillUpdate,
  SkillUpdateApply,
} from "../schemas/skill";
import { AdminAccess } from "../security";

/** The scope segment, spelled exactly as the file routes spell it. */
const scopeParams = { scope: FileScopeAddress };

/** That scope, and one skill in it. */
const skillParams = { ...scopeParams, name: SkillName };

/**
 * What one scope has installed, in name order.
 *
 * Answered from the lock, checked against the disk: `present` and `linked` say
 * whether the directory and its link are really there, because a person can
 * delete either through the file routes and a list that hid that would be a
 * list of what somebody once installed.
 *
 * A skill written by hand rather than installed from a source has no lock row
 * and is not here. It is in the file browser, under the same two paths, and
 * that is the honest place for it — the lock records where bytes came from, and
 * for a hand-written skill the answer is "somebody wrote them".
 */
const list = HttpApiEndpoint.get("list", "/skills/:scope", {
  error: [Forbidden, InvalidInput, NotFound],
  params: scopeParams,
  success: Schema.Array(InstalledSkill),
})
  .middleware(AdminAccess)
  .annotate(OpenApi.Summary, "List the skills installed in a scope");

/**
 * Fetches a skill from GitHub and writes it into the scope.
 *
 * The credential is the one this system already holds — the same token the host
 * clones with — so a private repository the board can already reach is a
 * repository a skill can come from, and no second login exists to keep in step.
 *
 * The skill is the directory holding the `SKILL.md`, not that file alone: a
 * document referring to a `references/` file and arriving without it is a skill
 * that half works.
 *
 * Installing over a name the lock already knows replaces it, which is what
 * makes a failed install repeatable. A directory of that name that no lock row
 * claims is refused instead — that is somebody's hand-written skill, and
 * overwriting it would destroy work no history holds.
 */
const install = HttpApiEndpoint.post("install", "/skills/:scope", {
  error: [Forbidden, InvalidInput, NotFound],
  params: scopeParams,
  payload: SkillInstall,
  success: InstalledSkill,
})
  .middleware(AdminAccess)
  .annotate(OpenApi.Summary, "Install a skill from GitHub into a scope");

/**
 * Asks the source what it holds now, and answers with the difference.
 *
 * Writes nothing. `changed` is false when the source hashes to what the lock
 * records, and the file list is still there — a person looking at a skill that
 * has not moved should see what it consists of rather than an empty answer.
 */
const checkUpdate = HttpApiEndpoint.get(
  "checkUpdate",
  "/skills/:scope/:name/update",
  {
    error: [Forbidden, InvalidInput, NotFound],
    params: skillParams,
    success: SkillUpdate,
  }
)
  .middleware(AdminAccess)
  .annotate(OpenApi.Summary, "Compare an installed skill with its source");

/**
 * Writes the update that was reviewed.
 *
 * The body carries the hash the check answered with, and the source is asked
 * again: a repository that moved between the review and the apply is refused
 * rather than written, so the bytes that land are the bytes somebody read.
 *
 * Files the source no longer has are removed, which is why the check reports
 * removals as well as changes.
 */
const applyUpdate = HttpApiEndpoint.post(
  "applyUpdate",
  "/skills/:scope/:name/update",
  {
    error: [Forbidden, InvalidInput, NotFound],
    params: skillParams,
    payload: SkillUpdateApply,
    success: InstalledSkill,
  }
)
  .middleware(AdminAccess)
  .annotate(OpenApi.Summary, "Apply a reviewed skill update");

/**
 * Removes a skill's directory, its link and its lock row together.
 *
 * Together is the point. Deleting the directory through the file routes leaves
 * a lock row pointing at nothing and a dangling link beside it, so this exists
 * to make "uninstall" one act rather than three a person has to remember.
 */
const uninstall = HttpApiEndpoint.delete("uninstall", "/skills/:scope/:name", {
  error: [Forbidden, InvalidInput, NotFound],
  params: skillParams,
})
  .middleware(AdminAccess)
  .annotate(OpenApi.Summary, "Uninstall a skill from a scope");

/** Skills: files in a scope, fetched from a repository and recorded in a lock. */
export class SkillsGroup extends HttpApiGroup.make("skills")
  .add(list, install, checkUpdate, applyUpdate, uninstall)
  .annotate(
    OpenApi.Description,
    "Skills installed into a directory of the agent filesystem. Codex reads them from every level of a run's tree; Claude reads the operator's personal skills instead."
  ) {}
