/**
 * The one rule for a path a caller supplies and this system joins to a
 * directory of ours.
 *
 * Two features hand us such a path and both turn it into a real file on the
 * host: a project's environment files, written into a run's checkout, and a
 * worker's proposal, written into a shared scope once a person accepts it. The
 * loop user owns the whole data root, so a path that escapes the directory it
 * was joined to writes anywhere that user can write — which makes this the same
 * rule twice rather than two rules that resemble each other, and one place is
 * how it stays that way.
 *
 * **Every rule is a refusal rather than a repair.** Normalizing a path that
 * contains `..` into one that does not is how a validator and the filesystem
 * come to disagree about which file was meant. Refusing is the only answer with
 * one reading.
 *
 * Refusing `.` and `..` outright is also what makes "stays under the root"
 * true by construction rather than by a second check: a path built only of
 * ordinary segments cannot climb out of the directory it is joined to, whatever
 * joins it.
 */

import { Schema } from "effect";

/** Segment separator. Posix, on both sides of every mount this system has. */
const SEPARATOR = "/";

/**
 * The longest path accepted. Well past any real `apps/<name>/.env.<suffix>` or
 * `manager/CLAUDE.md`, and well short of a filesystem's own limit, so the
 * refusal is ours and readable rather than an `ENAMETOOLONG` from the middle of
 * a write.
 */
export const RELATIVE_PATH_MAX = 256;

/** Why a path is not one we will join to a directory. A closed set, so an API error can name one. */
export const RELATIVE_PATH_REFUSALS = [
  "empty",
  "too_long",
  "absolute",
  "dot_segment",
  "empty_segment",
  "backslash",
  "control_character",
  "git_directory",
] as const;

/** What is wrong with a path. */
export type RelativePathRefusal = (typeof RELATIVE_PATH_REFUSALS)[number];

/** The first printable character: everything below it is NUL and the rest of C0. */
const FIRST_PRINTABLE = " ";

/** Delete. Above the printable range, and no more a filename than NUL is. */
const DELETE_CHARACTER = "\u007f";

/** True for a character no path of ours may carry. */
const isControl = (character: string) =>
  character < FIRST_PRINTABLE || character === DELETE_CHARACTER;

/**
 * What is wrong with one relative path, or null when nothing is. Pure and
 * total, which is what lets the same answer be given by a schema at decode, by
 * a dashboard as the operator types, and by the writer a moment before it
 * writes.
 *
 * A backslash is a legal character in a unix filename and is refused anyway. It
 * is never what anybody means, and `..\` in a path a Windows-shaped tool later
 * interprets is the one segment this rule exists to keep out.
 *
 * A `.git` segment is refused anywhere in the path, and it earns its place
 * twice over. A checkout is a real repository, so a file written to
 * `.git/hooks/pre-commit` runs on the next commit — an environment file turned
 * into arbitrary code. A shared artifacts scope is a repository too, since
 * `@workspace/sandbox`'s history snapshots it around every run, so the same
 * write there would forge the history that is meant to be the audit trail.
 * Anywhere rather than at the front, since a submodule keeps its own hooks one
 * directory down.
 */
export const relativePathRefusalOf = (
  path: string
): RelativePathRefusal | null => {
  if (path.length === 0) {
    return "empty";
  }
  if (path.length > RELATIVE_PATH_MAX) {
    return "too_long";
  }
  if (path.startsWith(SEPARATOR)) {
    return "absolute";
  }
  if (path.includes("\\")) {
    return "backslash";
  }
  if ([...path].some(isControl)) {
    return "control_character";
  }
  const segments = path.split(SEPARATOR);
  if (segments.some((segment) => segment.length === 0)) {
    return "empty_segment";
  }
  if (segments.some((segment) => segment === "." || segment === "..")) {
    return "dot_segment";
  }
  if (segments.includes(".git")) {
    return "git_directory";
  }
  return null;
};

/**
 * The refusal as the message a decode failure carries, for a brand that means
 * "relative to `what`". Every such brand shares the check and differs only in
 * the noun a reader is shown, so the noun is the argument and the rule is not.
 */
export const relativePathFilter = (what: string) =>
  Schema.makeFilter((path: string) => {
    const refusal = relativePathRefusalOf(path);
    return refusal === null ? undefined : `not a ${what}: ${refusal}`;
  });
