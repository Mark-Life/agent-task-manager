/**
 * What a skill is called, and where in a repository its `SKILL.md` sits.
 *
 * A skill is installed by writing files: a directory of real files at one place
 * in a scope and a link to it at another. Both of those paths are built from the
 * name, and the source path is joined to somebody else's repository — so these
 * two brands are the whole input surface of that install, and the rules they
 * carry are the reason the writer downstream never has to ask whether a caller
 * meant it.
 *
 * **A name is one segment, never a path.** `../rules` as a name would write a
 * skill's files into the scope above the skills directory, and `a/b` would put
 * one skill inside another where an update to either would prune the other's
 * files. Refusing the separator outright is what makes "a skill's files stay in
 * a skill's directory" true of the type rather than of a check somewhere.
 *
 * **A source path is relative to the repository that was named.** It is the
 * same rule the other caller-supplied paths in this system carry — see
 * `./relative-path` — with one addition of its own, which is that the file at
 * the end of it has to be the skill file. That last check lives with the fetch,
 * where the name of the file is known.
 */

import { Schema } from "effect";
import { relativePathFilter } from "./relative-path";

/**
 * The longest skill name accepted. Long enough for the descriptive names skills
 * actually carry — `effect-client-wrapper` is twenty-one characters — and short
 * enough that the two paths built from it stay well inside any filesystem's own
 * limit.
 */
export const SKILL_NAME_MAX = 64;

/** Why a string is not a skill name. A closed set, so a refusal can name one. */
export const SKILL_NAME_REFUSALS = [
  "empty",
  "too_long",
  "not_one_segment",
] as const;

/** What is wrong with a name. */
export type SkillNameRefusal = (typeof SKILL_NAME_REFUSALS)[number];

/**
 * One directory segment: a letter or a digit, then letters, digits, dots,
 * dashes and underscores.
 *
 * Anchored, so nothing after a newline counts — an unanchored test would accept
 * `ok\n../escape`. The leading character may not be a dot, which is what keeps
 * a skill from being installed as `.git`, as `..`, or as a hidden directory a
 * person browsing the tree would not see.
 */
const SKILL_NAME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

/**
 * What is wrong with one skill name, or null when nothing is. Pure and total,
 * so a dashboard can say it as somebody types and the schema below can say it
 * at decode without the two disagreeing.
 */
export const skillNameRefusalOf = (name: string): SkillNameRefusal | null => {
  if (name.length === 0) {
    return "empty";
  }
  if (name.length > SKILL_NAME_MAX) {
    return "too_long";
  }
  return SKILL_NAME_PATTERN.test(name) ? null : "not_one_segment";
};

/**
 * The name of one installed skill, which is also the name of its directory and
 * of the link beside it.
 *
 * Branded because the two paths an install writes are composed from it, and a
 * string that reached that composition unchecked would be a caller choosing
 * where in the scope the files land.
 */
export const SkillName = Schema.String.annotate({
  description:
    "A skill's name: one directory segment of letters, digits, dots, dashes and underscores.",
  identifier: "SkillName",
}).pipe(
  Schema.check(
    Schema.makeFilter((name: string) => {
      const refusal = skillNameRefusalOf(name);
      return refusal === null ? undefined : `not a skill name: ${refusal}`;
    })
  ),
  Schema.brand("SkillName")
);

export type SkillName = typeof SkillName.Type;

/**
 * The path of a `SKILL.md` inside the repository it was named with.
 *
 * The same refusals every other caller-supplied path in this system carries,
 * under a noun that says which root it is relative to: this one is joined to a
 * URL rather than to a directory, and `..` in it would ask GitHub's contents API
 * for a path above the repository somebody named.
 */
export const SkillSourcePath = Schema.String.annotate({
  description:
    "Path to a SKILL.md inside the repository, relative to its root. No leading slash and no `..`.",
  identifier: "SkillSourcePath",
}).pipe(
  Schema.check(relativePathFilter("repository-relative path")),
  Schema.brand("SkillSourcePath")
);

export type SkillSourcePath = typeof SkillSourcePath.Type;

/** Where a skill came from. One kind today, and a field rather than an assumption. */
export const SKILL_SOURCE_TYPES = ["github"] as const;

/** Which kind of source a lock row names. */
export const SkillSourceType = Schema.Literals(SKILL_SOURCE_TYPES);
export type SkillSourceType = typeof SkillSourceType.Type;

/**
 * One skill's row in a scope's lock: the same four fields the repository's own
 * `skills-lock.json` carries, spelled the same way, so the two files are one
 * format and a person who has read one has read the other.
 *
 * Four fields and no more. A fifth — a branch, a commit — would be something
 * this system stored and then had to keep true, and an update is defined as
 * "ask the source again and compare", which needs none of them.
 *
 * Here rather than beside the writer, because the wire and the host both hold
 * this shape: the file `@workspace/sandbox` serializes and the row the API
 * answers with are the same four fields, and two declarations of them would
 * disagree the first time one gained a field.
 */
export const SkillLockEntry = Schema.Struct({
  /**
   * Hex sha256 over the installed files. Bare hex rather than the `sha256:`
   * form an artifact copy records, because the lock files that already exist
   * are bare and a prefix here would make ours unreadable by whatever reads
   * theirs.
   */
  computedHash: Schema.String,
  /** Path of the `SKILL.md` inside the source repository. */
  skillPath: SkillSourcePath,
  /** `owner/repo` — what a lock row can carry without carrying a credential. */
  source: Schema.String,
  sourceType: SkillSourceType,
}).annotate({ identifier: "SkillLockEntry" });

export interface SkillLockEntry
  extends Schema.Schema.Type<typeof SkillLockEntry> {}

/**
 * What an update does to one file of a skill.
 *
 * Here because both ends of an update name it: the comparison that produces the
 * answer is host-side, and the answer is a wire shape somebody's browser
 * renders. One union, so a status added to the comparison is a status the
 * contract already knows.
 */
export const SKILL_FILE_STATUSES = [
  "added",
  "changed",
  "removed",
  "unchanged",
] as const;

/** Which of the four. */
export const SkillFileStatus = Schema.Literals(SKILL_FILE_STATUSES);
export type SkillFileStatus = typeof SkillFileStatus.Type;
