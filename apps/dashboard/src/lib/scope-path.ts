/**
 * Where a path clicked in a listing, or typed into a box, becomes a path a file
 * route will accept.
 *
 * A directory listing describes what is on disk, so an entry's path arrives as
 * a plain string — a folder can honestly hold a name no request could ever
 * spell, a backslash or a control character among them. Every route takes the
 * branded path instead, which means the browser has to decide per entry whether
 * it can be opened at all, and that decision is made once here rather than at
 * the five call sites that would each answer it slightly differently.
 *
 * Nothing here makes a path safe. The server contains every path against the
 * scope's real directory whatever this file says; these functions exist so a
 * person is told "that name cannot be addressed" before a request instead of
 * being shown a refusal after one.
 */

import { relativePathRefusalOf, ScopePath } from "@workspace/domain";
import { Option, Schema } from "effect";

/** What separates one segment of a scope-relative path from the next. */
const SEPARATOR = "/";

const decode = Schema.decodeUnknownOption(ScopePath);

/**
 * A path the file routes will take, or null when this one is unaddressable.
 *
 * Null is a real answer rather than a failure: a listing shows every entry, and
 * an entry whose name carries a control character is visible and not openable.
 * Callers render the null as a row that cannot be clicked, which is the honest
 * pair — hiding the file would say the folder is empty when it is not.
 */
export const scopePathOf = (value: string) => Option.getOrNull(decode(value));

/** The last segment: what a browser draws once it has already drawn the parent. */
export const nameOf = (path: string) =>
  path.slice(path.lastIndexOf(SEPARATOR) + 1);

/**
 * The directory a path sits in, and null when that directory is the scope's own
 * root. Null rather than the empty string, because the empty string is not a
 * path any route accepts — the root is named by leaving the path out.
 */
export const parentOf = (path: string) => {
  const cut = path.lastIndexOf(SEPARATOR);
  return cut <= 0 ? null : scopePathOf(path.slice(0, cut));
};

/**
 * Every directory above a path, shallowest first.
 *
 * What a tree opened on a deep link has to expand: a link to
 * `.agents/skills/review/SKILL.md` is useless if the two folders above it are
 * still shut, and the reader has no way to know which they were.
 */
export const ancestorsOf = (path: string): readonly string[] => {
  const segments = path.split(SEPARATOR).slice(0, -1);
  return segments.map((_, depth) =>
    segments.slice(0, depth + 1).join(SEPARATOR)
  );
};

/** A name put inside a directory, or at the scope's root when there is none. */
export const joinScopePath = (directory: string | null, name: string) =>
  directory === null || directory === "" ? name : `${directory}/${name}`;

/**
 * Where a symlink points, as a path inside the same scope, or null when it
 * leaves.
 *
 * The skills layout is one real folder under `.agents/skills/<name>` and a
 * **relative** link at `.claude/skills/<name>` pointing back down at it, so
 * following one is climbing with `..` and descending again — and the branded
 * path a route accepts has no `..` in it. Resolving that here is what lets a
 * reader open the real file from the link, instead of being shown a target
 * string they have to work out by hand.
 *
 * Null for an absolute target, for one that climbs past the scope's own root,
 * and for anything the routes would refuse anyway. The server refuses to follow
 * a link out of the scope whatever this says; this only decides whether to
 * offer the reader a way through.
 */
export const resolveLinkTarget = (directory: string | null, target: string) => {
  if (target.startsWith(SEPARATOR)) {
    return null;
  }
  const segments = [
    ...(directory === null ? [] : directory.split(SEPARATOR)),
    ...target.split(SEPARATOR),
  ];
  const walked: string[] = [];
  for (const segment of segments) {
    if (segment === "" || segment === ".") {
      continue;
    }
    if (segment !== "..") {
      walked.push(segment);
      continue;
    }
    if (walked.length === 0) {
      return null;
    }
    walked.pop();
  }

  return scopePathOf(walked.join(SEPARATOR));
};

/**
 * What each refusal means to the person typing the path.
 *
 * The same rule the proposals and the environment files are branded off, said
 * for this reader: a path here is relative to one scope's own directory rather
 * than to a checkout, and `.git` is refused because the shared scopes keep
 * their history in one — which is the record of what every run and every person
 * changed.
 */
const REFUSALS: Record<string, string> = {
  absolute: "Give a path inside the scope, not one starting with “/”.",
  backslash: "Use “/” between directories.",
  control_character: "That path has a character a filename cannot hold.",
  dot_segment: "No “.” or “..” — the path has to stay inside the scope.",
  empty: "Give it a name.",
  empty_segment: "Two slashes in a row, or a trailing one.",
  git_directory:
    "“.git” is this scope's history. Nothing may be written into it.",
  too_long: "That path is longer than the routes accept.",
};

/**
 * The complaint about a path, or null when there is nothing to say. An empty
 * box is not a complaint — a person who has typed nothing yet is not wrong yet.
 */
export const scopePathProblem = (path: string) => {
  if (path === "") {
    return null;
  }
  const refusal = relativePathRefusalOf(path);
  return refusal === null ? null : (REFUSALS[refusal] ?? "Not a usable path.");
};
