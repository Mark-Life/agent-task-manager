/**
 * A skill on the wire: what one installed skill is, what installing one takes,
 * and what an update would do before anybody agrees to it.
 *
 * A skill is not a row anywhere. It is a directory of files in a scope plus one
 * line in that scope's `skills-lock.json`, so everything here is read off the
 * disk at the moment it is asked for — which is why {@link InstalledSkill}
 * carries `present` and `linked` rather than assuming the lock and the tree
 * agree. They can disagree: a person can delete a skill's directory through the
 * file routes, and a lock row pointing at nothing is exactly the state somebody
 * needs to be shown rather than protected from.
 *
 * **An update is two calls, and that is the point.** {@link SkillUpdate} is what
 * the source holds now against what is installed, file by file, and applying it
 * is a separate request quoting the hash that was reviewed. One call that
 * fetched and wrote would be an update nobody read, which is the thing a lock
 * file exists to prevent.
 */

import {
  SkillFileStatus,
  SkillLockEntry,
  SkillName,
  SkillSourcePath,
} from "@workspace/domain";
import { Schema } from "effect";

/**
 * One skill a scope has, as the lock records it plus where it actually is.
 *
 * The four lock fields are spread rather than restated, so this shape cannot
 * drift from the file on disk. The three added ones are what a browser needs to
 * act: the two scope-relative paths, so opening a skill's `SKILL.md` in the file
 * routes needs no knowledge of the layout, and whether each of them is really
 * there.
 */
export const InstalledSkill = Schema.Struct({
  ...SkillLockEntry.fields,
  /** Scope-relative directory of the real files, `.agents/skills/<name>`. */
  directory: Schema.String,
  /** Scope-relative path of the symbolic link beside them, `.claude/skills/<name>`. */
  link: Schema.String,
  /** False when the link is missing or is no longer a link to the directory. */
  linked: Schema.Boolean,
  name: SkillName,
  /** False when the lock has a row and the directory is gone. */
  present: Schema.Boolean,
}).annotate({ identifier: "InstalledSkill" });

export interface InstalledSkill
  extends Schema.Schema.Type<typeof InstalledSkill> {}

/**
 * What installing a skill takes: a repository, the path of a `SKILL.md` in it,
 * and optionally a name to install it under.
 *
 * The repository is a URL a person pastes rather than an owner and a repo, so
 * it is the same string this system already accepts for a project and is parsed
 * by the same function. The name defaults to the directory holding the
 * `SKILL.md`, which is the name its author chose; an override exists because two
 * sources can offer a skill of the same name and only one directory can win.
 *
 * No branch and no commit. The lock carries four fields, and a ref nobody
 * stored would silently drift to the default branch on the first update — a
 * pin that is not kept is worse than no pin.
 */
export const SkillInstall = Schema.Struct({
  name: Schema.optionalKey(SkillName),
  path: SkillSourcePath,
  repoUrl: Schema.String,
}).annotate({ identifier: "SkillInstall" });

export interface SkillInstall extends Schema.Schema.Type<typeof SkillInstall> {}

/**
 * One line of the review: which file, what happens to it, and the text that
 * would land.
 *
 * Only the incoming side travels. What is installed is already readable through
 * the file routes at `<directory>/<path>`, and reading it there is also how a
 * person sees the edits somebody made to an installed skill by hand — which is
 * exactly what an update is about to prune.
 */
export const SkillFileChange = Schema.Struct({
  /** The incoming size. Zero for a file the source no longer has. */
  bytes: Schema.Natural,
  /** Null for a removed file, for bytes that are not text, and for one too large to review. */
  content: Schema.NullOr(Schema.String),
  /** Relative to the skill's own directory. */
  path: Schema.String,
  status: SkillFileStatus,
}).annotate({ identifier: "SkillFileChange" });

export interface SkillFileChange
  extends Schema.Schema.Type<typeof SkillFileChange> {}

/**
 * What the source holds now, against what is installed.
 *
 * `latestHash` is what an apply has to quote. A person reads the changes, the
 * dashboard sends that hash back, and an apply whose re-fetch produces a
 * different one is refused — so the bytes that land are the bytes somebody
 * looked at, even though the source was asked twice.
 */
export const SkillUpdate = Schema.Struct({
  /** False when the source hashes to what is already installed. */
  changed: Schema.Boolean,
  /** The hash the lock holds, which is what is on disk unless somebody edited it. */
  currentHash: Schema.String,
  files: Schema.Array(SkillFileChange),
  /** What the source hashes to now. Quote it to apply. */
  latestHash: Schema.String,
  name: SkillName,
}).annotate({ identifier: "SkillUpdate" });

export interface SkillUpdate extends Schema.Schema.Type<typeof SkillUpdate> {}

/**
 * The hash from the update that was read.
 *
 * Required rather than optional, because it is the only thing separating "apply
 * what somebody reviewed" from "fetch and write whatever is there now" — and
 * the second one is what an update route without a review would be.
 */
export const SkillUpdateApply = Schema.Struct({
  expectedHash: Schema.String,
}).annotate({ identifier: "SkillUpdateApply" });

export interface SkillUpdateApply
  extends Schema.Schema.Type<typeof SkillUpdateApply> {}
