/**
 * The environment files a project hands to every run that works in its repo.
 *
 * **The unit is a file, not a key-value pair.** Key-value rows cannot say where
 * a value goes: one monorepo keeps everything in a root `.env.local`, another
 * needs one per app, and `apps/web/.env` and `packages/db/.env.test` are two
 * files rather than two sets of keys. A file also survives comments, blank lines,
 * multi-line values and whatever quoting the reader expects, all four of which
 * a key-value editor destroys on the first save.
 *
 * **The path is the natural key and the only thing here that is validated
 * hard.** It is turned into a filesystem path inside the run's checkout, so a
 * path that escapes the checkout writes anywhere the loop user can write — and
 * the loop user owns the whole data root. {@link EnvFilePath} is the one rule,
 * declared as a schema so the API refuses a bad path at decode, the store
 * refuses it at encode, and the materializer re-checks it before it writes.
 *
 * The content is not in this file. It is a secret, it is stored encrypted, and
 * the only shapes that carry it are the two below that say so in their names —
 * so a handler that means to list paths cannot accidentally return the values.
 */

import { Schema } from "effect";
import { ProjectEnvFileId, ProjectId } from "./ids";
import { recordFields } from "./primitives";

/** Segment separator of a repo-relative path. Posix, on both sides of the mount. */
const SEPARATOR = "/";

/**
 * The longest path accepted. Well past any real `apps/<name>/.env.<suffix>` and
 * well short of a filesystem's own limit, so the refusal is ours and readable
 * rather than an `ENAMETOOLONG` from the middle of a materialization.
 */
export const ENV_FILE_PATH_MAX = 256;

/** Why a path is not somewhere a run may be handed a file. A closed set, so an API error can name one. */
export const ENV_PATH_REFUSALS = [
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
export type EnvPathRefusal = (typeof ENV_PATH_REFUSALS)[number];

/** The first printable character: everything below it is NUL and the rest of C0. */
const FIRST_PRINTABLE = " ";

/** Delete. Above the printable range, and no more a filename than NUL is. */
const DELETE_CHARACTER = "\u007f";

/** True for a character no path of ours may carry. */
const isControl = (character: string) =>
  character < FIRST_PRINTABLE || character === DELETE_CHARACTER;

/**
 * What is wrong with one repo-relative path, or null when nothing is.
 *
 * Pure and total, and every rule is a refusal rather than a repair. Normalizing
 * a path that contains `..` into one that does not is how a validator and the
 * filesystem come to disagree about which file was meant; refusing is the only
 * answer with one reading.
 *
 * `..` and `.` are refused outright rather than resolved, which also makes the
 * "stays under the workspace root" property true by construction: a path built
 * only of ordinary segments cannot climb out of the directory it is joined to.
 *
 * A backslash is a legal character in a unix filename and is refused anyway. It
 * is never what an operator means, and `..\` in a path a Windows-shaped tool
 * later interprets is the one segment this rule exists to keep out.
 *
 * A `.git` segment is refused anywhere in the path, because the checkout is a
 * real repository: a file written to `.git/hooks/pre-commit` runs on the next
 * commit, which turns an environment file into arbitrary code. Anywhere rather
 * than at the front, since a submodule keeps its own hooks one directory down.
 */
export const envPathRefusalOf = (path: string): EnvPathRefusal | null => {
  if (path.length === 0) {
    return "empty";
  }
  if (path.length > ENV_FILE_PATH_MAX) {
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

/** The refusal as the message a decode failure carries. */
const pathFilter = Schema.makeFilter((path: string) => {
  const refusal = envPathRefusalOf(path);
  return refusal === null ? undefined : `not a repo-relative path: ${refusal}`;
});

/**
 * Where an environment file goes, relative to the root of the run's checkout.
 *
 * Branded, so a string that has not been through {@link envPathRefusalOf}
 * cannot be joined to a workspace directory by accident — the brand is the
 * evidence that the check happened.
 */
export const EnvFilePath = Schema.String.pipe(
  Schema.check(pathFilter),
  Schema.brand("EnvFilePath")
);
export type EnvFilePath = typeof EnvFilePath.Type;

/**
 * One environment file as everything but the editor sees it: where it goes and
 * when it last changed, and never what is in it.
 *
 * The content is absent by construction rather than by a handler remembering to
 * strip it. Listing the files of a project is the common read — it renders the
 * editor's sidebar and it answers "what does this project inject" — and a shape
 * that carried the values would put every project's secrets into every one of
 * those responses.
 */
export const ProjectEnvFile = Schema.Struct({
  ...recordFields,
  id: ProjectEnvFileId,
  path: EnvFilePath,
  projectId: ProjectId,
});

export interface ProjectEnvFile
  extends Schema.Schema.Type<typeof ProjectEnvFile> {}

/**
 * One environment file with its text, which is the shape exactly two things
 * take: the editor reading a file back, and the materializer writing it into a
 * checkout.
 */
export const ProjectEnvFileContent = Schema.Struct({
  ...ProjectEnvFile.fields,
  /** The file's whole text, decrypted. Never logged, never on an event. */
  content: Schema.String,
});

export interface ProjectEnvFileContent
  extends Schema.Schema.Type<typeof ProjectEnvFileContent> {}

/**
 * A file as the materializer takes it: a path and bytes, with none of the row
 * it came from. `@workspace/sandbox` writes these and never learns that a
 * project, a workspace or an encryption key was involved.
 */
export interface EnvFileWrite {
  readonly content: string;
  readonly path: EnvFilePath;
}
